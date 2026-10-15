// Persistent settings and credentials, stored in chrome.storage.local.

import { DEFAULT_OAUTH_CLIENT_ID } from '../config.js';

export const DEFAULT_SETTINGS = Object.freeze({
	includeCommitAuthors: true,
	includeReviewers: true,
	includeCommenters: true,
	includePrAuthor: false,
	useDisplayNames: true,
	/** Logins never to credit, one per line. */
	ignoredLogins: '',
	oauthClientId: DEFAULT_OAUTH_CLIENT_ID,
	requestPrivateRepoAccess: false,
});

/** @returns {Promise<typeof DEFAULT_SETTINGS>} */
export async function getSettings() {
	const { settings } = await chrome.storage.local.get('settings');
	return { ...DEFAULT_SETTINGS, ...settings };
}

/** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
export async function saveSettings(patch) {
	const settings = { ...(await getSettings()), ...patch };
	await chrome.storage.local.set({ settings });
	return settings;
}

/**
 * @typedef {object} StoredAuth
 * @property {string} token
 * @property {'device' | 'pat'} method How the token was obtained.
 * @property {string} login GitHub login the token belongs to.
 * @property {string | null} avatarUrl
 * @property {number} savedAt
 */

/** @returns {Promise<StoredAuth | null>} */
export async function getAuth() {
	const { auth } = await chrome.storage.local.get('auth');
	return auth?.token ? auth : null;
}

/** @param {StoredAuth} auth */
export async function setAuth(auth) {
	await chrome.storage.local.set({ auth });
}

export async function clearAuth() {
	await chrome.storage.local.remove('auth');
}
