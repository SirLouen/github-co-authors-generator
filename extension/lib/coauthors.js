// Pure helpers that turn pull request activity into `Co-authored-by` trailers.

const NOREPLY_PATTERN = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i;
const CO_AUTHOR_PATTERN = /^co-authored-by:[ \t]*(.*?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;
// Trailer tokens are hyphenated words such as Co-authored-by, Signed-off-by or Change-Id.
const TRAILER_LINE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+:[ \t]+\S/;
// Accounts that are not people but are not typed "Bot" either: deleted users, the accounts that
// GitHub links automation emails (github-actions@github.com, action@github.com) to, and Copilot.
const NON_HUMAN_LOGINS = new Set(['ghost', 'actions-user', 'invalid-email-address', 'web-flow', 'copilot']);
// Git identities used by GitHub Actions workflows and GitHub's own web commits.
const AUTOMATION_EMAIL_PATTERN = /^(?:noreply|actions?|github-actions)@github\.com$/i;

/**
 * @typedef {object} Participant
 * @property {string | null} login GitHub login, or null for commit authors without a linked account.
 * @property {string} name Name to show in the trailer.
 * @property {string} email Email to put in the trailer.
 * @property {string[]} emails Every email known for this person, used to detect existing trailers.
 * @property {string[]} sources Where they took part: 'author', 'commit', 'review' or 'comment'.
 */

/** GitHub's private commit email for an account; GitHub always attributes it to that account. */
export function noreplyEmail(user) {
	return `${user.id}+${user.login}@users.noreply.github.com`;
}

/** The login encoded in a `users.noreply.github.com` address, lowercased. */
export function loginFromNoreplyEmail(email) {
	const match = email.match(NOREPLY_PATTERN);
	return match ? match[1].toLowerCase() : null;
}

/** @param {{ login?: string, type?: string } | null | undefined} user */
export function isHumanUser(user) {
	if (!user?.login) return false;
	const login = user.login.toLowerCase();
	if (NON_HUMAN_LOGINS.has(login) || login.endsWith('[bot]')) return false;
	return !user.type || user.type === 'User';
}

/** Whether a git name and email belong to a bot or to automation rather than a person. */
function isBotIdentity({ name = '', email = '' }) {
	if (/\[bot\]$/i.test(name.trim()) || /\[bot\]@/i.test(email) || AUTOMATION_EMAIL_PATTERN.test(email)) return true;
	const noreplyLogin = loginFromNoreplyEmail(email);
	return noreplyLogin !== null && !isHumanUser({ login: noreplyLogin });
}

/** Parses the `Co-authored-by: Name <email>` trailers found in a commit message. */
export function parseCoAuthorTrailers(message) {
	return Array.from(message.matchAll(CO_AUTHOR_PATTERN), ([, name, email]) => ({ name, email }));
}

/**
 * Collects the people who took part in a pull request.
 *
 * Accepts the raw REST API payloads for the pull request and its activity lists.
 * @param {object} activity
 * @param {any} activity.pull `GET /repos/{owner}/{repo}/pulls/{number}`
 * @param {any[]} [activity.commits] `GET .../pulls/{number}/commits`
 * @param {any[]} [activity.reviews] `GET .../pulls/{number}/reviews`
 * @param {any[]} [activity.reviewComments] `GET .../pulls/{number}/comments`
 * @param {any[]} [activity.issueComments] `GET .../issues/{number}/comments`
 * @param {object} options
 * @param {boolean} options.includeCommitAuthors
 * @param {boolean} options.includeReviewers
 * @param {boolean} options.includeCommenters
 * @param {boolean} options.includePrAuthor
 * @returns {Participant[]}
 */
export function collectParticipants(
	{ pull, commits = [], reviews = [], reviewComments = [], issueComments = [] },
	options,
) {
	/** @type {Map<string, { login: string | null, gitName: string | null, emails: string[], sources: Set<string> }>} */
	const people = new Map();
	/** @type {Map<string, string>} Maps lowercased emails to the key of the person who owns them. */
	const keyByEmail = new Map();

	const addEmail = (person, key, email) => {
		if (!email || isBotIdentity({ email })) return;
		const normalized = email.toLowerCase();
		if (!person.emails.some((known) => known.toLowerCase() === normalized)) person.emails.push(email);
		keyByEmail.set(normalized, key);
	};

	/** Moves everything known under `fromKey` to `toKey`. */
	const mergeInto = (fromKey, toKey) => {
		const from = people.get(fromKey);
		const to = people.get(toKey);
		people.delete(fromKey);
		if (!to) {
			people.set(toKey, from);
			for (const email of from.emails) keyByEmail.set(email.toLowerCase(), toKey);
			return;
		}
		to.gitName ||= from.gitName;
		for (const source of from.sources) to.sources.add(source);
		for (const email of from.emails) addEmail(to, toKey, email);
	};

	/** Adds a GitHub account, merging repeated appearances. */
	const addUser = (user, source, gitIdentity = null) => {
		if (!isHumanUser(user)) return;
		const key = `login:${user.login.toLowerCase()}`;
		// Someone first seen only through a commit email turns out to be this account.
		const emailKey = gitIdentity?.email && keyByEmail.get(gitIdentity.email.toLowerCase());
		if (emailKey && emailKey !== key) mergeInto(emailKey, key);
		let person = people.get(key);
		if (!person) {
			person = { login: user.login, gitName: null, emails: [], sources: new Set() };
			people.set(key, person);
		}
		person.login = user.login;
		person.sources.add(source);
		if (gitIdentity) {
			person.gitName ||= gitIdentity.name || null;
			addEmail(person, key, gitIdentity.email);
		}
		addEmail(person, key, noreplyEmail(user));
	};

	/** Adds someone known only by a git name and email (no linked GitHub account). */
	const addGitIdentity = ({ name, email }, source) => {
		if (!email || isBotIdentity({ name, email })) return;
		const noreplyLogin = loginFromNoreplyEmail(email);
		const key =
			keyByEmail.get(email.toLowerCase()) ??
			(noreplyLogin ? `login:${noreplyLogin}` : `email:${email.toLowerCase()}`);
		let person = people.get(key);
		if (!person) {
			person = { login: null, gitName: null, emails: [], sources: new Set() };
			people.set(key, person);
		}
		person.sources.add(source);
		person.gitName ||= name || null;
		addEmail(person, key, email);
	};

	if (options.includePrAuthor && pull?.user) addUser(pull.user, 'author');

	if (options.includeCommitAuthors) {
		for (const commit of commits) {
			const gitAuthor = commit.commit?.author;
			// Automation commits (e.g. a workflow that formats code) credit nobody, even when GitHub
			// links their email to an account. Their trailers may still name people.
			const automated = Boolean(gitAuthor) && isBotIdentity(gitAuthor);
			if (commit.author && !automated) {
				addUser(commit.author, 'commit', gitAuthor);
			} else if (gitAuthor) {
				addGitIdentity(gitAuthor, 'commit');
			}
			for (const coAuthor of parseCoAuthorTrailers(commit.commit?.message ?? '')) {
				addGitIdentity(coAuthor, 'commit');
			}
		}
	}

	if (options.includeReviewers) {
		// The API also returns the viewer's own unsubmitted (PENDING) review.
		const submittedReviews = reviews.filter((review) => review.state !== 'PENDING');
		for (const { user } of [...submittedReviews, ...reviewComments]) addUser(user, 'review');
	}

	if (options.includeCommenters) {
		for (const { user } of issueComments) addUser(user, 'comment');
	}

	// A squash merge is authored by the PR author. The merge box also names the commit author, and
	// addCoAuthorsToMessage() leaves that email out.
	const prAuthorLogin = options.includePrAuthor ? null : pull?.user?.login?.toLowerCase();

	const participants = [];
	for (const person of people.values()) {
		const login = person.login ?? loginFromNoreplyEmail(person.emails[0] ?? '');
		if (login && login.toLowerCase() === prAuthorLogin) continue;
		if (person.emails.length === 0) continue;
		participants.push({
			login: person.login,
			name: person.gitName || person.login || login || person.emails[0],
			email: person.emails[0],
			emails: person.emails,
			sources: [...person.sources],
		});
	}
	return participants;
}

/** Replaces each participant's name with their GitHub profile name, when they have one. */
export function applyDisplayNames(participants, namesByLogin) {
	return participants.map((participant) => {
		const name = participant.login && namesByLogin.get(participant.login.toLowerCase());
		return name ? { ...participant, name } : participant;
	});
}

/** @param {{ name: string, email: string }} person */
export function formatCoAuthorTrailer({ name, email }) {
	const safeName = name.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || email;
	return `Co-authored-by: ${safeName} <${email}>`;
}

/** Appends trailers to a commit message, keeping all trailers in the final paragraph. */
export function appendTrailers(message, trailers) {
	if (trailers.length === 0) return message;
	const body = message.replace(/\s+$/, '');
	if (!body) return trailers.join('\n');
	const lastParagraph = body.split(/\n[ \t]*\n/).pop() ?? '';
	const endsWithTrailers = lastParagraph.split('\n').every((line) => TRAILER_LINE_PATTERN.test(line));
	return `${body}${endsWithTrailers ? '\n' : '\n\n'}${trailers.join('\n')}`;
}

/**
 * Adds a trailer for every participant not already credited in `message`.
 * @param {string} message Current extended description.
 * @param {Participant[]} participants
 * @param {object} [options]
 * @param {string[]} [options.excludeEmails] Emails to never add, such as the merge commit's author.
 */
export function addCoAuthorsToMessage(message, participants, { excludeEmails = [] } = {}) {
	const knownEmails = new Set();
	const knownLogins = new Set();
	const remember = (email) => {
		knownEmails.add(email.toLowerCase());
		const login = loginFromNoreplyEmail(email);
		if (login) knownLogins.add(login);
	};
	for (const { email } of parseCoAuthorTrailers(message)) remember(email);
	for (const email of excludeEmails) remember(email);

	const trailers = [];
	let skipped = 0;
	for (const participant of participants) {
		const alreadyCredited =
			participant.emails.some((email) => knownEmails.has(email.toLowerCase())) ||
			(participant.login !== null && knownLogins.has(participant.login.toLowerCase()));
		if (alreadyCredited) {
			skipped++;
			continue;
		}
		trailers.push(formatCoAuthorTrailer(participant));
		participant.emails.forEach(remember);
	}
	return { message: appendTrailers(message, trailers), added: trailers.length, skipped };
}
