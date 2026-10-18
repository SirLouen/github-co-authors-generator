import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { getUsableAuth, REFRESH_MARGIN_MS, withGitHubClient } from '../extension/lib/auth.js';

const NOW = 1_800_000_000_000;
const now = () => NOW;

/** An in-memory stand-in for chrome.storage.local. */
function fakeStorage(initial) {
	const data = structuredClone(initial);
	globalThis.chrome = {
		storage: {
			local: {
				get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
				set: async (items) => Object.assign(data, structuredClone(items)),
			},
		},
	};
	return data;
}

/** Answers token refreshes and API calls; API calls succeed only with `validToken`. */
function fakeGitHub({ validToken, refreshResponse }) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url, init });
		if (url.includes('/login/oauth/access_token')) {
			calls.at(-1).body = Object.fromEntries(new URLSearchParams(init.body));
			return Response.json(refreshResponse);
		}
		const ok = init.headers?.Authorization === `Bearer ${validToken}`;
		return Response.json(ok ? { login: 'alice' } : { message: 'Bad credentials' }, { status: ok ? 200 : 401 });
	};
	return { fetchImpl, calls };
}

const NEW_TOKENS = {
	access_token: 'ghu_new',
	expires_in: 28800,
	refresh_token: 'ghr_new',
	refresh_token_expires_in: 15897600,
};

function deviceAuth(overrides = {}) {
	return {
		token: 'ghu_old',
		method: 'device',
		login: 'alice',
		avatarUrl: null,
		savedAt: 0,
		refreshToken: 'ghr_old',
		expiresAt: NOW + 60 * 60_000,
		refreshTokenExpiresAt: NOW + 30 * 86_400_000,
		clientId: 'Ov23li_app',
		...overrides,
	};
}

describe('getUsableAuth', () => {
	beforeEach(() => delete globalThis.chrome);

	it('leaves a token alone while it has time left', async () => {
		fakeStorage({ auth: deviceAuth() });
		const { fetchImpl, calls } = fakeGitHub({ refreshResponse: NEW_TOKENS });
		assert.equal((await getUsableAuth({ fetchImpl, now })).token, 'ghu_old');
		assert.equal(calls.length, 0);
	});

	it('refreshes a token that is about to expire and saves the new pair', async () => {
		const storage = fakeStorage({ auth: deviceAuth({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 }) });
		const { fetchImpl, calls } = fakeGitHub({ refreshResponse: NEW_TOKENS });
		const auth = await getUsableAuth({ fetchImpl, now });
		assert.deepEqual(calls[0].body, { client_id: 'Ov23li_app', grant_type: 'refresh_token', refresh_token: 'ghr_old' });
		assert.equal(auth.token, 'ghu_new');
		assert.deepEqual(storage.auth, {
			...deviceAuth(),
			token: 'ghu_new',
			refreshToken: 'ghr_new',
			expiresAt: NOW + 28_800_000,
			refreshTokenExpiresAt: NOW + 15_897_600_000,
		});
	});

	it('spends a refresh token only once when two callers need it', async () => {
		fakeStorage({ auth: deviceAuth({ expiresAt: NOW - 1 }) });
		const { fetchImpl, calls } = fakeGitHub({ refreshResponse: NEW_TOKENS });
		const [a, b] = await Promise.all([getUsableAuth({ fetchImpl, now }), getUsableAuth({ fetchImpl, now })]);
		assert.equal(a.token, 'ghu_new');
		assert.equal(b.token, 'ghu_new');
		assert.equal(calls.length, 1);
	});

	it('falls back to the client ID in the settings for sign-ins saved without one', async () => {
		fakeStorage({ auth: deviceAuth({ expiresAt: NOW - 1, clientId: undefined }), settings: { oauthClientId: 'Ov23li_settings' } });
		const { fetchImpl, calls } = fakeGitHub({ refreshResponse: NEW_TOKENS });
		await getUsableAuth({ fetchImpl, now });
		assert.equal(calls[0].body.client_id, 'Ov23li_settings');
	});

	it('keeps the saved sign-in when GitHub refuses the refresh token', async () => {
		const storage = fakeStorage({ auth: deviceAuth({ expiresAt: NOW - 1 }) });
		const { fetchImpl } = fakeGitHub({ refreshResponse: { error: 'bad_refresh_token' } });
		assert.equal((await getUsableAuth({ fetchImpl, now })).token, 'ghu_old');
		assert.equal(storage.auth.token, 'ghu_old');
	});

	it('never refreshes personal access tokens', async () => {
		fakeStorage({ auth: { token: 'ghp_pat', method: 'pat', login: 'alice', avatarUrl: null, savedAt: 0 } });
		const { fetchImpl, calls } = fakeGitHub({ refreshResponse: NEW_TOKENS });
		assert.equal((await getUsableAuth({ fetchImpl, now, force: true })).token, 'ghp_pat');
		assert.equal(calls.length, 0);
	});
});

describe('withGitHubClient', () => {
	beforeEach(() => delete globalThis.chrome);

	it('refreshes and retries once when GitHub rejects a token before its expiry time', async () => {
		fakeStorage({ auth: deviceAuth() });
		const { fetchImpl } = fakeGitHub({ validToken: 'ghu_new', refreshResponse: NEW_TOKENS });
		const user = await withGitHubClient((client) => client.request('/user'), { fetchImpl, now });
		assert.deepEqual(user, { login: 'alice' });
	});

	it('passes the 401 on when there is nothing to refresh', async () => {
		fakeStorage({ auth: { token: 'ghp_revoked', method: 'pat', login: 'alice', avatarUrl: null, savedAt: 0 } });
		const { fetchImpl } = fakeGitHub({ validToken: 'other', refreshResponse: NEW_TOKENS });
		await assert.rejects(withGitHubClient((client) => client.request('/user'), { fetchImpl, now }), {
			code: 'unauthorized',
		});
	});

	it('passes the 401 on when the refresh fails too', async () => {
		fakeStorage({ auth: deviceAuth() });
		const { fetchImpl } = fakeGitHub({ validToken: 'ghu_new', refreshResponse: { error: 'bad_refresh_token' } });
		await assert.rejects(withGitHubClient((client) => client.request('/user'), { fetchImpl, now }), {
			code: 'unauthorized',
		});
	});
});
