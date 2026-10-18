// Keeps a device-flow sign-in working when GitHub issues access tokens that expire after eight hours.

import { refreshAccessToken } from './device-flow.js';
import { createGitHubClient, GitHubApiError } from './github.js';
import { getAuth, getSettings, setAuth } from './settings.js';

/** Refresh this long before the access token expires, so a request never races the expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const LOCK_NAME = 'github-token-refresh';

let localQueue = Promise.resolve();

/**
 * Runs one refresh at a time. Refresh tokens are single use, so the settings page and the service
 * worker must not both spend the same one. Web Locks cover both; the fallback covers one context.
 */
function exclusively(task) {
	if (globalThis.navigator?.locks) return navigator.locks.request(LOCK_NAME, task);
	const result = localQueue.then(task);
	localQueue = result.catch(() => {});
	return result;
}

/**
 * Returns the saved sign-in, refreshed first when its access token has expired or is about to.
 * Personal access tokens and long-lived OAuth tokens are returned as they are. If GitHub refuses the
 * refresh, the saved sign-in is returned unchanged and its requests fail with `unauthorized`, which
 * tells the user to sign in again.
 * @param {object} [options]
 * @param {boolean} [options.force] Refresh even if the token looks valid, e.g. after a 401.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {Promise<import('./settings.js').StoredAuth | null>}
 */
export async function getUsableAuth({ force = false, fetchImpl, now = Date.now } = {}) {
	const auth = await getAuth();
	if (!auth?.refreshToken || (!force && !expiresSoon(auth, now))) return auth;

	return exclusively(async () => {
		// Another page or the service worker may have refreshed while this one waited.
		const current = await getAuth();
		if (!current?.refreshToken || current.token !== auth.token) return current;
		const clientId = current.clientId || (await getSettings()).oauthClientId;
		try {
			const tokens = await refreshAccessToken({ clientId, refreshToken: current.refreshToken, fetchImpl, now });
			const refreshed = {
				...current,
				token: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
				refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
				clientId,
			};
			await setAuth(refreshed);
			return refreshed;
		} catch (error) {
			console.warn('Could not refresh the GitHub token:', error);
			return current;
		}
	});
}

function expiresSoon(auth, now) {
	return typeof auth.expiresAt === 'number' && auth.expiresAt - now() <= REFRESH_MARGIN_MS;
}

/**
 * Calls `run` with a GitHub client for the saved sign-in. If GitHub rejects a token that can be
 * refreshed, it refreshes once and calls `run` again.
 * @template T
 * @param {(client: ReturnType<typeof createGitHubClient>, auth: import('./settings.js').StoredAuth | null) => Promise<T>} run
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {Promise<T>}
 */
export async function withGitHubClient(run, { fetchImpl, now } = {}) {
	const auth = await getUsableAuth({ fetchImpl, now });
	try {
		return await run(createGitHubClient({ token: auth?.token, fetchImpl }), auth);
	} catch (error) {
		const retryable = auth?.refreshToken && error instanceof GitHubApiError && error.code === 'unauthorized';
		if (!retryable) throw error;
		const refreshed = await getUsableAuth({ force: true, fetchImpl, now });
		if (!refreshed?.token || refreshed.token === auth.token) throw error;
		return run(createGitHubClient({ token: refreshed.token, fetchImpl }), refreshed);
	}
}
