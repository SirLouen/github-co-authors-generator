import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	DeviceFlowError,
	pollForAccessToken,
	refreshAccessToken,
	requestDeviceCode,
} from '../extension/lib/device-flow.js';

/** A fetch stub returning queued JSON responses in order. */
function queuedFetch(responses) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)), headers: init.headers });
		const { status = 200, body } = responses.shift();
		return new Response(JSON.stringify(body), { status });
	};
	return { fetchImpl, calls };
}

/** A clock that only advances when the code under test sleeps. */
function fakeClock() {
	let time = 0;
	const sleeps = [];
	return {
		now: () => time,
		sleep: async (ms) => {
			sleeps.push(ms);
			time += ms;
		},
		sleeps,
	};
}

describe('requestDeviceCode', () => {
	it('requests a code for the client ID and scope', async () => {
		const { fetchImpl, calls } = queuedFetch([
			{
				body: {
					device_code: 'dev',
					user_code: 'ABCD-1234',
					verification_uri: 'https://github.com/login/device',
					expires_in: 899,
					interval: 5,
				},
			},
		]);
		const code = await requestDeviceCode({ clientId: 'Ov23li', scope: 'repo', fetchImpl });
		assert.deepEqual(code, {
			deviceCode: 'dev',
			userCode: 'ABCD-1234',
			verificationUri: 'https://github.com/login/device',
			expiresIn: 899,
			interval: 5,
		});
		assert.equal(calls[0].url, 'https://github.com/login/device/code');
		assert.deepEqual(calls[0].body, { client_id: 'Ov23li', scope: 'repo' });
		assert.equal(calls[0].headers.Accept, 'application/json');
	});

	it('explains an unknown client ID', async () => {
		const { fetchImpl } = queuedFetch([{ status: 404, body: { error: 'Not Found' } }]);
		await assert.rejects(requestDeviceCode({ clientId: 'nope', fetchImpl }), DeviceFlowError);
	});

	it('explains a disabled device flow', async () => {
		const { fetchImpl } = queuedFetch([{ body: { error: 'device_flow_disabled' } }]);
		await assert.rejects(requestDeviceCode({ clientId: 'x', fetchImpl }), {
			code: 'device_flow_disabled',
			message: /Enable it/,
		});
	});
});

describe('pollForAccessToken', () => {
	it('waits while authorization is pending and slows down when asked', async () => {
		const clock = fakeClock();
		const { fetchImpl, calls } = queuedFetch([
			{ body: { error: 'authorization_pending' } },
			{ body: { error: 'slow_down', interval: 10 } },
			{ body: { error: 'authorization_pending' } },
			{ body: { access_token: 'gho_token', token_type: 'bearer', scope: '' } },
		]);
		const result = await pollForAccessToken({
			clientId: 'cid',
			deviceCode: 'dev',
			interval: 5,
			expiresIn: 900,
			fetchImpl,
			...clock,
		});
		assert.deepEqual(result, {
			accessToken: 'gho_token',
			scope: '',
			refreshToken: null,
			expiresAt: null,
			refreshTokenExpiresAt: null,
		});
		assert.deepEqual(clock.sleeps, [5000, 5000, 10000, 10000]);
		assert.deepEqual(calls[0].body, {
			client_id: 'cid',
			device_code: 'dev',
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		});
	});

	it('returns the refresh token and expiry times of an expiring token', async () => {
		const clock = fakeClock();
		const { fetchImpl } = queuedFetch([
			{
				body: {
					access_token: 'ghu_token',
					scope: '',
					expires_in: 28800,
					refresh_token: 'ghr_refresh',
					refresh_token_expires_in: 15897600,
				},
			},
		]);
		const result = await pollForAccessToken({ clientId: 'c', deviceCode: 'd', interval: 5, expiresIn: 900, fetchImpl, ...clock });
		assert.deepEqual(result, {
			accessToken: 'ghu_token',
			scope: '',
			refreshToken: 'ghr_refresh',
			expiresAt: 5000 + 28_800_000,
			refreshTokenExpiresAt: 5000 + 15_897_600_000,
		});
	});

	it('stops when the user denies access', async () => {
		const { fetchImpl } = queuedFetch([{ body: { error: 'access_denied' } }]);
		await assert.rejects(
			pollForAccessToken({ clientId: 'c', deviceCode: 'd', interval: 5, expiresIn: 900, fetchImpl, ...fakeClock() }),
			{ code: 'access_denied' },
		);
	});

	it('gives up once the code expires', async () => {
		const pending = Array.from({ length: 3 }, () => ({ body: { error: 'authorization_pending' } }));
		const { fetchImpl } = queuedFetch(pending);
		await assert.rejects(
			pollForAccessToken({ clientId: 'c', deviceCode: 'd', interval: 5, expiresIn: 15, fetchImpl, ...fakeClock() }),
			{ code: 'expired_token' },
		);
	});

	it('can be cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetchImpl } = queuedFetch([]);
		await assert.rejects(
			pollForAccessToken({
				clientId: 'c',
				deviceCode: 'd',
				interval: 5,
				expiresIn: 900,
				fetchImpl,
				signal: controller.signal,
				sleep: async (ms, signal) => signal.throwIfAborted(),
			}),
			{ name: 'AbortError' },
		);
	});
});

describe('refreshAccessToken', () => {
	it('swaps the refresh token for a new pair without a client secret', async () => {
		const { fetchImpl, calls } = queuedFetch([
			{ body: { access_token: 'ghu_new', expires_in: 28800, refresh_token: 'ghr_new', refresh_token_expires_in: 100 } },
		]);
		const result = await refreshAccessToken({ clientId: 'Ov23li', refreshToken: 'ghr_old', fetchImpl, now: () => 1000 });
		assert.deepEqual(calls[0].body, { client_id: 'Ov23li', grant_type: 'refresh_token', refresh_token: 'ghr_old' });
		assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
		assert.deepEqual(result, {
			accessToken: 'ghu_new',
			scope: '',
			refreshToken: 'ghr_new',
			expiresAt: 1000 + 28_800_000,
			refreshTokenExpiresAt: 1000 + 100_000,
		});
	});

	it('reports a refresh token GitHub no longer accepts', async () => {
		const { fetchImpl } = queuedFetch([{ body: { error: 'bad_refresh_token' } }]);
		await assert.rejects(refreshAccessToken({ clientId: 'c', refreshToken: 'r', fetchImpl }), {
			code: 'bad_refresh_token',
			message: /sign in again/,
		});
	});
});
