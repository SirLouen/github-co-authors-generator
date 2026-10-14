// Service worker: makes the GitHub API calls with the saved token, so the token never reaches github.com.

import { addCoAuthorsToMessage, applyDisplayNames, collectParticipants } from './lib/coauthors.js';
import { createGitHubClient, GitHubApiError } from './lib/github.js';
import { getAuth, getSettings } from './lib/settings.js';

const DISPLAY_NAME_BATCH_SIZE = 50;

// Keep the token out of reach of content scripts, which only talk to this worker.
function restrictStorageAccess() {
	chrome.storage.local
		.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
		.catch((error) => console.warn('Could not restrict storage access:', error));
}
restrictStorageAccess();
chrome.runtime.onStartup.addListener(restrictStorageAccess);

chrome.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (sender.id !== chrome.runtime.id) return false;
	const handler = handlers[message?.type];
	if (!handler) return false;
	handler(message, sender).then(sendResponse, (error) =>
		sendResponse({ ok: false, error: serializeError(error) }),
	);
	return true;
});

const handlers = {
	/** Loads the participants of a pull request. */
	async 'coauthors:fetch'({ owner, repo, number, viewerLogin }) {
		if (!isValidSegment(owner) || !isValidSegment(repo) || !Number.isInteger(number)) {
			throw new Error('Not a pull request page.');
		}
		const [auth, settings] = await Promise.all([getAuth(), getSettings()]);
		const client = createGitHubClient({ token: auth?.token });
		const pullPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
		const issuePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
		const none = Promise.resolve([]);

		const [pull, commits, reviews, reviewComments, issueComments] = await Promise.all([
			client.request(pullPath),
			settings.includeCommitAuthors ? client.paginate(`${pullPath}/commits`) : none,
			settings.includeReviewers ? client.paginate(`${pullPath}/reviews`) : none,
			settings.includeReviewers ? client.paginate(`${pullPath}/comments`) : none,
			settings.includeCommenters ? client.paginate(`${issuePath}/comments`) : none,
		]);

		let participants = collectParticipants(
			{ pull, commits, reviews, reviewComments, issueComments },
			{ ...settings, mergerLogin: viewerLogin || auth?.login || null },
		);
		// Profile names cost one GraphQL request, which needs a token.
		if (settings.useDisplayNames && client.authenticated) {
			participants = applyDisplayNames(participants, await fetchDisplayNames(client, participants));
		}

		return {
			ok: true,
			participants,
			authenticated: client.authenticated,
			rateLimit: client.rateLimit,
		};
	},

	/** Appends trailers for participants who are not credited in the message yet. */
	async 'coauthors:compose'({ message, participants, excludeEmails }) {
		return { ok: true, ...addCoAuthorsToMessage(String(message ?? ''), participants, { excludeEmails }) };
	},

	async 'options:open'() {
		await chrome.runtime.openOptionsPage();
		return { ok: true };
	},
};

/** Looks up GitHub profile names; failures are ignored because logins work as names too. */
async function fetchDisplayNames(client, participants) {
	const logins = [...new Set(participants.map((p) => p.login).filter(Boolean))];
	const names = new Map();
	for (let start = 0; start < logins.length; start += DISPLAY_NAME_BATCH_SIZE) {
		const batch = logins.slice(start, start + DISPLAY_NAME_BATCH_SIZE);
		const variables = Object.fromEntries(batch.map((login, i) => [`l${i}`, login]));
		const query = `query(${batch.map((_, i) => `$l${i}: String!`).join(', ')}) {
			${batch.map((_, i) => `u${i}: user(login: $l${i}) { login name }`).join('\n')}
		}`;
		try {
			const { data } = await client.graphql(query, variables);
			for (const user of Object.values(data ?? {})) {
				if (user?.name) names.set(user.login.toLowerCase(), user.name);
			}
		} catch (error) {
			console.warn('Could not load GitHub profile names:', error);
		}
	}
	return names;
}

function isValidSegment(value) {
	return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function serializeError(error) {
	if (error instanceof GitHubApiError) {
		return {
			message: error.message,
			code: error.code,
			authenticated: error.authenticated,
			resetAt: error.resetAt,
		};
	}
	console.error(error);
	return { message: error?.message || 'Something went wrong.', code: 'unknown' };
}
