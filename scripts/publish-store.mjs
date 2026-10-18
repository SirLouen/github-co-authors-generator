// Uploads a release ZIP to the Chrome Web Store and submits it for review, using the Chrome Web Store
// API v2 and a Google Cloud service account. Used by the "store" job in .github/workflows/release.yml.
//
//   node scripts/publish-store.mjs <zip>
//
// Reads these environment variables, which the workflow fills from the repository secret and variables
// of the same names:
//   CHROME_WEBSTORE_SERVICE_ACCOUNT  the service account's JSON key
//   CHROME_WEBSTORE_PUBLISHER_ID     the publisher ID from the Developer Dashboard
//   CHROME_WEBSTORE_EXTENSION_ID     the extension's item ID
// When any of them is empty, it prints why and exits without doing anything, so releases still work
// before the store is set up.
//
// API docs: https://developer.chrome.com/docs/webstore/using-api

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const UPLOAD_POLL_SECONDS = 5;
const UPLOAD_TIMEOUT_SECONDS = 300;

export function missingSettings(env) {
	return ['CHROME_WEBSTORE_SERVICE_ACCOUNT', 'CHROME_WEBSTORE_PUBLISHER_ID', 'CHROME_WEBSTORE_EXTENSION_ID'].filter((name) => !env[name]?.trim());
}

export function parseServiceAccount(json) {
	let key;
	try {
		key = JSON.parse(json);
	} catch {
		throw new Error('CHROME_WEBSTORE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file downloaded from Google Cloud.');
	}
	if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
		throw new Error('CHROME_WEBSTORE_SERVICE_ACCOUNT is not a service account key (needs type, client_email and private_key).');
	}
	return key;
}

const base64url = (value) => Buffer.from(value).toString('base64url');

// The signed JWT a service account exchanges for an access token.
export function buildAssertion(key, now = Math.floor(Date.now() / 1000)) {
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = base64url(
		JSON.stringify({
			iss: key.client_email,
			scope: SCOPE,
			aud: key.token_uri || DEFAULT_TOKEN_URI,
			iat: now,
			exp: now + 3600,
		}),
	);
	const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key, 'base64url');
	return `${header}.${claims}.${signature}`;
}

async function call(fetchImpl, url, init, action) {
	const response = await fetchImpl(url, init);
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!response.ok) {
		const detail = body.error?.message ?? body.error_description ?? body.error ?? body.raw ?? text;
		throw new Error(`${action} failed (HTTP ${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
	}
	return body;
}

export async function fetchAccessToken(key, fetchImpl = fetch) {
	const body = await call(
		fetchImpl,
		key.token_uri || DEFAULT_TOKEN_URI,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: buildAssertion(key),
			}),
		},
		'Getting an access token',
	);
	return body.access_token;
}

export async function publishToStore({ zip, publisherId, extensionId, token, fetchImpl = fetch, sleep, log = console.log }) {
	const wait = sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)));
	const item = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
	const auth = { Authorization: `Bearer ${token}` };

	const upload = await call(
		fetchImpl,
		`${API}/upload/v2/${item}:upload`,
		{
			method: 'POST',
			headers: { ...auth, 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': 'extension.zip' },
			body: zip,
		},
		'Uploading the ZIP',
	);

	let state = upload.uploadState;
	for (let waited = 0; state === 'IN_PROGRESS' && waited < UPLOAD_TIMEOUT_SECONDS; waited += UPLOAD_POLL_SECONDS) {
		await wait(UPLOAD_POLL_SECONDS);
		const status = await call(fetchImpl, `${API}/v2/${item}:fetchStatus`, { headers: auth }, 'Checking the upload');
		state = status.lastAsyncUploadState;
	}
	if (state !== 'SUCCEEDED') {
		throw new Error(`The store did not accept the upload (state: ${state ?? 'unknown'}). ${JSON.stringify(upload)}`);
	}
	log(`Uploaded version ${upload.crxVersion ?? '(unknown)'} of ${extensionId}.`);

	const published = await call(
		fetchImpl,
		`${API}/v2/${item}:publish`,
		{
			method: 'POST',
			headers: { ...auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
		},
		'Submitting for review',
	);
	log(`Submitted for review (state: ${published.state ?? 'unknown'}). It goes live once the review passes.`);
	return published;
}

async function main(args, env) {
	const [zipPath] = args;
	if (!zipPath) {
		throw new Error('Usage: node scripts/publish-store.mjs <zip>');
	}
	const missing = missingSettings(env);
	if (missing.length > 0) {
		console.log(`Skipping the Chrome Web Store upload: ${missing.join(', ')} not set. See README.md, "Publishing to the Chrome Web Store".`);
		return;
	}
	const key = parseServiceAccount(env.CHROME_WEBSTORE_SERVICE_ACCOUNT);
	const token = await fetchAccessToken(key);
	await publishToStore({
		zip: await readFile(zipPath),
		publisherId: env.CHROME_WEBSTORE_PUBLISHER_ID.trim(),
		extensionId: env.CHROME_WEBSTORE_EXTENSION_ID.trim(),
		token,
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2), process.env).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
