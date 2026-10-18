import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { buildAssertion, missingSettings, parseServiceAccount, publishToStore } from '../scripts/publish-store.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
	type: 'service_account',
	client_email: 'publisher@example.iam.gserviceaccount.com',
	private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
	token_uri: 'https://oauth2.googleapis.com/token',
};

function fakeFetch(responses) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url, init });
		const [status, body] = responses.shift();
		return { ok: status < 400, status, text: async () => JSON.stringify(body) };
	};
	return { calls, fetchImpl };
}

describe('missingSettings', () => {
	it('lists empty or blank settings', () => {
		assert.deepEqual(missingSettings({ CHROME_WEBSTORE_SERVICE_ACCOUNT: '{}', CHROME_WEBSTORE_PUBLISHER_ID: ' ' }), [
			'CHROME_WEBSTORE_PUBLISHER_ID',
			'CHROME_WEBSTORE_EXTENSION_ID',
		]);
		assert.deepEqual(missingSettings({ CHROME_WEBSTORE_SERVICE_ACCOUNT: '{}', CHROME_WEBSTORE_PUBLISHER_ID: 'p', CHROME_WEBSTORE_EXTENSION_ID: 'e' }), []);
	});
});

describe('parseServiceAccount', () => {
	it('accepts a service account key and rejects anything else', () => {
		assert.equal(parseServiceAccount(JSON.stringify(key)).client_email, key.client_email);
		assert.throws(() => parseServiceAccount('not json'), /not valid JSON/);
		assert.throws(() => parseServiceAccount('{"type":"authorized_user"}'), /not a service account key/);
	});
});

describe('buildAssertion', () => {
	it('signs a JWT for the Chrome Web Store scope', () => {
		const jwt = buildAssertion(key, 1000);
		const [header, claims, signature] = jwt.split('.');
		assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
		assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
			iss: key.client_email,
			scope: 'https://www.googleapis.com/auth/chromewebstore',
			aud: 'https://oauth2.googleapis.com/token',
			iat: 1000,
			exp: 4600,
		});
		const valid = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url');
		assert.ok(valid);
	});
});

describe('publishToStore', () => {
	const options = { zip: Buffer.from('zip'), publisherId: 'pub', extensionId: 'ext', token: 't', log: () => {} };

	it('uploads, waits for processing, then submits for review', async () => {
		const { calls, fetchImpl } = fakeFetch([
			[200, { uploadState: 'IN_PROGRESS', crxVersion: '1.2.0' }],
			[200, { lastAsyncUploadState: 'SUCCEEDED' }],
			[200, { state: 'PENDING_REVIEW' }],
		]);
		const result = await publishToStore({ ...options, fetchImpl, sleep: async () => {} });

		assert.equal(result.state, 'PENDING_REVIEW');
		assert.deepEqual(
			calls.map((call) => call.url),
			[
				'https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/ext:upload',
				'https://chromewebstore.googleapis.com/v2/publishers/pub/items/ext:fetchStatus',
				'https://chromewebstore.googleapis.com/v2/publishers/pub/items/ext:publish',
			],
		);
		assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
		assert.deepEqual(JSON.parse(calls[2].init.body), { publishType: 'DEFAULT_PUBLISH' });
	});

	it('stops before publishing when the upload fails', async () => {
		const { calls, fetchImpl } = fakeFetch([[200, { uploadState: 'FAILED', itemError: [{ error_detail: 'bad' }] }]]);
		await assert.rejects(publishToStore({ ...options, fetchImpl }), /did not accept the upload \(state: FAILED\)/);
		assert.equal(calls.length, 1);
	});

	it('reports the API error message', async () => {
		const { fetchImpl } = fakeFetch([[403, { error: { code: 403, message: 'The caller does not have permission' } }]]);
		await assert.rejects(publishToStore({ ...options, fetchImpl }), /Uploading the ZIP failed \(HTTP 403\): The caller does not have permission/);
	});
});
