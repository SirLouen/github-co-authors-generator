import { pollForAccessToken, requestDeviceCode } from '../lib/device-flow.js';
import { withGitHubClient } from '../lib/auth.js';
import { createGitHubClient, GitHubApiError } from '../lib/github.js';
import { clearAuth, getAuth, getSettings, saveSettings, setAuth } from '../lib/settings.js';

const $ = (selector) => document.querySelector(selector);

const elements = {
	signedIn: $('#signed-in'),
	signedOut: $('#signed-out'),
	avatar: $('#avatar'),
	loginLink: $('#login-link'),
	authMethod: $('#auth-method'),
	signOut: $('#sign-out'),
	deviceStart: $('#device-start'),
	devicePanel: $('#device-panel'),
	deviceCode: $('#device-code'),
	deviceOpen: $('#device-open'),
	deviceCancel: $('#device-cancel'),
	deviceStatus: $('#device-status'),
	patForm: $('#pat-form'),
	patInput: $('#pat-input'),
	accountMessage: $('#account-message'),
	rateLimit: $('#rate-limit'),
	settingsForm: $('#settings-form'),
	advanced: $('#advanced'),
	advancedForm: $('#advanced-form'),
	clientId: $('#client-id'),
	saved: $('#saved'),
};

/** @type {AbortController | null} */
let deviceFlow = null;
let verificationUri = 'https://github.com/login/device';

init();

async function init() {
	await Promise.all([renderAccount(), renderSettings()]);

	elements.deviceStart.addEventListener('click', startDeviceFlow);
	elements.deviceOpen.addEventListener('click', copyCodeAndOpenGitHub);
	elements.deviceCancel.addEventListener('click', cancelDeviceFlow);
	elements.patForm.addEventListener('submit', savePersonalAccessToken);
	elements.signOut.addEventListener('click', signOut);
	elements.settingsForm.addEventListener('change', saveFormSettings);
	elements.advancedForm.addEventListener('change', saveFormSettings);
	elements.advancedForm.addEventListener('submit', (event) => event.preventDefault());

	// Stay in sync with changes made from other tabs.
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && 'auth' in changes) renderAccount();
	});
}

async function renderAccount() {
	const auth = await getAuth();
	elements.signedIn.hidden = !auth;
	elements.signedOut.hidden = Boolean(auth);
	if (auth) {
		elements.avatar.src = auth.avatarUrl || '../icons/icon-48.png';
		elements.loginLink.textContent = `@${auth.login}`;
		elements.loginLink.href = `https://github.com/${encodeURIComponent(auth.login)}`;
		elements.authMethod.textContent =
			auth.method === 'device' ? 'Signed in with GitHub' : 'Using a personal access token';
	}
	renderRateLimit(auth);
}

async function renderRateLimit(auth) {
	try {
		const { resources } = await withGitHubClient((client) => client.request('/rate_limit'));
		const { limit, remaining, reset } = resources.core;
		const resetTime = new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		elements.rateLimit.textContent =
			`${remaining.toLocaleString()} of ${limit.toLocaleString()} ` +
			`${auth ? '' : 'anonymous '}API requests left this hour (resets at ${resetTime}).`;
	} catch (error) {
		elements.rateLimit.textContent = '';
		if (auth && error instanceof GitHubApiError && error.code === 'unauthorized') {
			showAccountMessage('GitHub no longer accepts the saved token. Sign out and sign in again.', 'error');
		}
	}
}

async function renderSettings() {
	const settings = await getSettings();
	for (const form of [elements.settingsForm, elements.advancedForm]) {
		for (const input of form.elements) {
			if (!(input.name in settings)) continue;
			if (input.type === 'checkbox') input.checked = settings[input.name];
			else input.value = settings[input.name];
		}
	}
}

let pendingSave = Promise.resolve();
function saveFormSettings(event) {
	const input = event.target;
	if (!input.name) return;
	const value = input.type === 'checkbox' ? input.checked : input.value.trim();
	// One save at a time, so quick successive changes don't overwrite each other.
	pendingSave = pendingSave.then(() => saveSettings({ [input.name]: value })).then(flashSaved, console.error);
}

async function startDeviceFlow() {
	// Read the form directly: its "change" save may still be in flight.
	const clientId = elements.clientId.value.trim();
	const requestPrivateRepoAccess = elements.advancedForm.elements.requestPrivateRepoAccess.checked;
	if (!clientId) {
		showAccountMessage('Add the client ID of your OAuth App under “Advanced” first.', 'error');
		elements.advanced.open = true;
		elements.clientId.focus();
		return;
	}

	cancelDeviceFlow();
	const controller = new AbortController();
	deviceFlow = controller;
	showAccountMessage('');
	elements.deviceStart.disabled = true;

	try {
		const code = await requestDeviceCode({
			clientId,
			scope: requestPrivateRepoAccess ? 'repo' : '',
			signal: controller.signal,
		});
		verificationUri = code.verificationUri;
		elements.deviceCode.textContent = code.userCode;
		elements.deviceStatus.textContent = 'Waiting for you to authorize the extension on GitHub…';
		elements.devicePanel.hidden = false;
		elements.deviceOpen.focus();

		const tokens = await pollForAccessToken({
			clientId,
			deviceCode: code.deviceCode,
			interval: code.interval,
			expiresIn: code.expiresIn,
			signal: controller.signal,
		});
		await saveToken(tokens.accessToken, 'device', {
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
			refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
			clientId,
		});
	} catch (error) {
		if (!controller.signal.aborted) showAccountMessage(error.message, 'error');
	} finally {
		if (deviceFlow === controller) {
			deviceFlow = null;
			resetDevicePanel();
		}
	}
}

async function copyCodeAndOpenGitHub() {
	try {
		await navigator.clipboard.writeText(elements.deviceCode.textContent);
		elements.deviceStatus.textContent = 'Code copied. Paste it on GitHub, then come back to this tab.';
	} catch {
		elements.deviceStatus.textContent = 'Type the code above on GitHub, then come back to this tab.';
	}
	chrome.tabs.create({ url: verificationUri });
}

function cancelDeviceFlow() {
	deviceFlow?.abort();
	deviceFlow = null;
	resetDevicePanel();
}

function resetDevicePanel() {
	elements.devicePanel.hidden = true;
	elements.deviceCode.textContent = '';
	elements.deviceStatus.textContent = '';
	elements.deviceStart.disabled = false;
}

async function savePersonalAccessToken(event) {
	event.preventDefault();
	const token = elements.patInput.value.trim();
	if (!token) return;
	const submit = elements.patForm.querySelector('button');
	submit.disabled = true;
	try {
		await saveToken(token, 'pat');
		elements.patInput.value = '';
	} catch (error) {
		showAccountMessage(
			error instanceof GitHubApiError && error.code === 'unauthorized'
				? 'GitHub rejected this token. Check that it is copied correctly and has not expired.'
				: error.message,
			'error',
		);
	} finally {
		submit.disabled = false;
	}
}

/**
 * Checks the token against GitHub, then stores it.
 * @param {string} token
 * @param {'device' | 'pat'} method
 * @param {object} [refresh] For expiring device-flow tokens: what is needed to renew them.
 */
async function saveToken(token, method, refresh = {}) {
	const user = await createGitHubClient({ token }).request('/user');
	await setAuth({
		token,
		method,
		login: user.login,
		avatarUrl: user.avatar_url ?? null,
		savedAt: Date.now(),
		...refresh,
	});
	await renderAccount();
	showAccountMessage(`Signed in as @${user.login}. The “Add co-authors” button now uses your account.`, 'success');
}

async function signOut() {
	const auth = await getAuth();
	await clearAuth();
	await renderAccount();
	showAccountMessage(
		auth?.method === 'device'
			? 'Signed out. To revoke the authorization on GitHub too, visit Settings → Applications → Authorized OAuth Apps.'
			: 'Signed out. The token was removed from this browser; delete it on GitHub if you no longer need it.',
	);
}

function showAccountMessage(text, tone = '') {
	elements.accountMessage.textContent = text;
	elements.accountMessage.className = `message ${tone}`.trim();
}

let savedTimer;
function flashSaved() {
	clearTimeout(savedTimer);
	elements.saved.textContent = 'Saved';
	savedTimer = setTimeout(() => (elements.saved.textContent = ''), 1500);
}
