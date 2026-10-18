// Service worker: makes the GitHub API calls with the saved token, so the token never reaches github.com.

import { addCoAuthorsToMessage, applyDisplayNames, collectParticipants, parseLoginList } from './lib/coauthors.js';
import { withGitHubClient } from './lib/auth.js';
import { GitHubApiError } from './lib/github.js';
import { getSettings } from './lib/settings.js';

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
	async 'coauthors:fetch'({ owner, repo, number }) {
		if (!isValidSegment(owner) || !isValidSegment(repo) || !Number.isInteger(number)) {
			throw new Error('Not a pull request page.');
		}
		const settings = await getSettings();
		// Retried once with a refreshed token if GitHub rejects an expired one.
		return withGitHubClient((client) => fetchParticipants(client, settings, { owner, repo, number }));
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

/** Loads the participants of a pull request. */
async function fetchParticipants(client, settings, { owner, repo, number }) {
	const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const pullPath = `${repoPath}/pulls/${number}`;
	const none = Promise.resolve([]);

	const [pull, firstCommits, reviews, reviewComments, issueComments] = await Promise.all([
		client.request(pullPath),
		settings.includeCommitAuthors ? client.paginate(`${pullPath}/commits`) : none,
		settings.includeReviewers ? client.paginate(`${pullPath}/reviews`) : none,
		settings.includeReviewers ? client.paginate(`${pullPath}/comments`) : none,
		settings.includeCommenters ? client.paginate(`${repoPath}/issues/${number}/comments`) : none,
	]);
	const { commits, incompleteReason } =
		settings.includeCommitAuthors && pull.commits > firstCommits.length
			? await fetchAllCommits(client, repoPath, pull, firstCommits)
			: { commits: firstCommits };

	let participants = collectParticipants(
		{ pull, commits, reviews, reviewComments, issueComments },
		{ ...settings, ignoredLogins: parseLoginList(settings.ignoredLogins) },
	);
	// Profile names cost one GraphQL request, which needs a token.
	if (settings.useDisplayNames && client.authenticated) {
		participants = applyDisplayNames(participants, await fetchDisplayNames(client, participants));
	}

	return {
		ok: true,
		participants,
		// Lets the page warn when some commits could not be read.
		commitCount: settings.includeCommitAuthors
			? { checked: commits.length, total: pull.commits, incompleteReason }
			: null,
		authenticated: client.authenticated,
		rateLimit: client.rateLimit,
	};
}

/**
 * The pull request commits endpoint stops at 250 commits, so longer pull requests are read through
 * the compare endpoint instead. It compares against the base branch as it is now, like GitHub does
 * for the PR's own commit list: `pull.base.sha` can be older and would pull in unrelated base
 * commits after "Update branch". A result with more commits than the PR has is not trusted. On
 * failure the first 250 are used, and `incompleteReason` tells the page why.
 */
async function fetchAllCommits(client, repoPath, pull, firstCommits) {
	const baseRef = pull.base.ref.split('/').map(encodeURIComponent).join('/');
	try {
		const commits = await client.paginate(
			`${repoPath}/compare/${baseRef}...${pull.head.sha}`,
			(page) => page.commits,
		);
		if (commits.length > firstCommits.length && commits.length <= pull.commits) return { commits };
		console.warn(`Compare returned ${commits.length} commits for a pull request with ${pull.commits}.`);
		return { commits: firstCommits };
	} catch (error) {
		console.warn('Could not list every commit of the pull request:', error);
		// Fine-grained tokens need "Contents" read access for the compare endpoint.
		const deniedAccess = error instanceof GitHubApiError && ['forbidden', 'not_found'].includes(error.code);
		return { commits: firstCommits, incompleteReason: deniedAccess ? 'contents_access' : 'error' };
	}
}

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
