// GitHub OAuth device flow: https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
// It needs only a public client ID, so no secret ships with the extension.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_INCREMENT_SECONDS = 5;

export class DeviceFlowError extends Error {
	/** @param {string} message @param {string} code GitHub's error code, e.g. `access_denied`. */
	constructor(message, code) {
		super(message);
		this.name = 'DeviceFlowError';
		this.code = code;
	}
}

const ERROR_MESSAGES = {
	access_denied: 'Authorization was cancelled on GitHub.',
	expired_token: 'The code expired before it was used. Start again.',
	device_flow_disabled: 'Device flow is disabled for this OAuth App. Enable it in the app’s settings on GitHub.',
	incorrect_client_credentials: 'GitHub does not recognize this OAuth App client ID.',
	unauthorized_client: 'GitHub does not recognize this OAuth App client ID.',
	incorrect_device_code: 'GitHub rejected the device code. Start again.',
	bad_refresh_token: 'Your GitHub sign-in has expired. Sign out and sign in again.',
};

async function postForm(fetchImpl, url, params, signal) {
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(params).toString(),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new DeviceFlowError(`Could not reach GitHub: ${error.message}`, 'network');
	}
	let data = null;
	try {
		data = await response.json();
	} catch {
		// Handled below.
	}
	if (data?.error) {
		throw new DeviceFlowError(
			ERROR_MESSAGES[data.error] ?? data.error_description ?? data.error,
			data.error,
		);
	}
	if (!response.ok || !data) {
		const code = response.status === 404 ? 'incorrect_client_credentials' : 'http';
		throw new DeviceFlowError(
			ERROR_MESSAGES[code] ?? `GitHub responded with status ${response.status}.`,
			code,
		);
	}
	return data;
}

/**
 * Starts the device flow.
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} [options.scope] Space-separated scopes. Empty grants read-only access to public data.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ deviceCode: string, userCode: string, verificationUri: string, expiresIn: number, interval: number }>}
 */
export async function requestDeviceCode({ clientId, scope = '', fetchImpl = (...args) => fetch(...args), signal }) {
	const data = await postForm(fetchImpl, DEVICE_CODE_URL, { client_id: clientId, scope }, signal);
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: data.verification_uri,
		expiresIn: Number(data.expires_in) || 900,
		interval: Number(data.interval) || 5,
	};
}

const defaultSleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/**
 * @typedef {object} TokenSet
 * @property {string} accessToken
 * @property {string} scope
 * @property {string | null} refreshToken Only sent when the OAuth App issues expiring tokens.
 * @property {number | null} expiresAt When the access token expires (ms since epoch), or null if it does not.
 * @property {number | null} refreshTokenExpiresAt When the refresh token expires (ms since epoch).
 */

/** Expiring tokens come with a refresh token and lifetimes in seconds; long-lived ones with neither. */
function toTokenSet(data, now) {
	const expiresIn = Number(data.expires_in);
	const refreshExpiresIn = Number(data.refresh_token_expires_in);
	return {
		accessToken: data.access_token,
		scope: data.scope ?? '',
		refreshToken: data.refresh_token || null,
		expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : null,
		refreshTokenExpiresAt: refreshExpiresIn > 0 ? now() + refreshExpiresIn * 1000 : null,
	};
}

/**
 * Polls until the user approves (or rejects) the device code on GitHub.
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.deviceCode
 * @param {number} options.interval Seconds between polls, as returned by `requestDeviceCode`.
 * @param {number} options.expiresIn Seconds until the device code expires.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<TokenSet>}
 */
export async function pollForAccessToken({
	clientId,
	deviceCode,
	interval,
	expiresIn,
	fetchImpl = (...args) => fetch(...args),
	sleep = defaultSleep,
	now = Date.now,
	signal,
}) {
	const expiresAt = now() + expiresIn * 1000;
	let delaySeconds = interval;
	while (now() < expiresAt) {
		await sleep(delaySeconds * 1000, signal);
		try {
			const data = await postForm(
				fetchImpl,
				ACCESS_TOKEN_URL,
				{ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT_TYPE },
				signal,
			);
			if (data.access_token) return toTokenSet(data, now);
		} catch (error) {
			if (!(error instanceof DeviceFlowError)) throw error;
			if (error.code === 'authorization_pending') continue;
			if (error.code === 'slow_down') {
				delaySeconds += SLOW_DOWN_INCREMENT_SECONDS;
				continue;
			}
			throw error;
		}
	}
	throw new DeviceFlowError(ERROR_MESSAGES.expired_token, 'expired_token');
}

/**
 * Swaps a refresh token for a new access token and refresh token. OAuth Apps created since August 2026
 * issue access tokens that expire after eight hours. Tokens from the device flow refresh without the
 * client secret. The old refresh token stops working once used.
 * @param {object} options
 * @param {string} options.clientId The client ID the token was issued to.
 * @param {string} options.refreshToken
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {Promise<TokenSet>}
 */
export async function refreshAccessToken({ clientId, refreshToken, fetchImpl = (...args) => fetch(...args), now = Date.now }) {
	const data = await postForm(fetchImpl, ACCESS_TOKEN_URL, {
		client_id: clientId,
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});
	if (!data.access_token) throw new DeviceFlowError('GitHub did not return a new token.', 'http');
	return toTokenSet(data, now);
}
