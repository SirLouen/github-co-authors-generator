import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	addCoAuthorsToMessage,
	appendTrailers,
	applyDisplayNames,
	collectParticipants,
	formatCoAuthorTrailer,
	parseCoAuthorTrailers,
	parseLoginList,
} from '../extension/lib/coauthors.js';

const ALL_SOURCES = {
	includeCommitAuthors: true,
	includeReviewers: true,
	includeCommenters: true,
	includePrAuthor: false,
};

const user = (login, id, type = 'User') => ({ login, id, type });
const commit = (author, gitName, gitEmail, message = 'Change things') => ({
	author,
	commit: { author: { name: gitName, email: gitEmail }, message },
});

const alice = user('alice', 1);
const bob = user('bob', 2);
const carol = user('carol', 3);
const dave = user('dave', 4);
const dependabot = user('dependabot[bot]', 49699333, 'Bot');

describe('collectParticipants', () => {
	it('collects commit authors, reviewers and commenters, without the PR author', () => {
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [commit(alice, 'Alice A.', 'alice@example.com'), commit(bob, 'Bob B.', 'bob@example.com')],
				reviews: [{ user: carol }],
				reviewComments: [{ user: carol }],
				issueComments: [{ user: dave }, { user: alice }],
			},
			ALL_SOURCES,
		);

		assert.deepEqual(
			participants.map(({ login, name, email, sources }) => ({ login, name, email, sources })),
			[
				{ login: 'bob', name: 'Bob B.', email: 'bob@example.com', sources: ['commit'] },
				{ login: 'carol', name: 'carol', email: '3+carol@users.noreply.github.com', sources: ['review'] },
				{ login: 'dave', name: 'dave', email: '4+dave@users.noreply.github.com', sources: ['comment'] },
			],
		);
	});

	it('keeps every known email of a person and merges their roles', () => {
		const [bobParticipant] = collectParticipants(
			{
				pull: { user: alice },
				commits: [commit(bob, 'Bob B.', 'bob@example.com')],
				issueComments: [{ user: bob }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(bobParticipant.emails, ['bob@example.com', '2+bob@users.noreply.github.com']);
		assert.deepEqual(bobParticipant.sources, ['commit', 'comment']);
	});

	it('skips bots, deleted users and organizations', () => {
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [
					commit(null, 'github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com'),
					commit(null, 'GitHub', 'noreply@github.com'),
				],
				reviews: [{ user: user('copilot-pull-request-reviewer[bot]', 5, 'Bot') }],
				issueComments: [{ user: user('ghost', 10137) }, { user: user('some-org', 6, 'Organization') }, { user: null }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(participants, []);
	});

	it('skips automation commits even when GitHub links their email to an account', () => {
		// Real links on github.com: action@ and actions@github.com belong to "actions-user",
		// github-actions@github.com to "invalid-email-address". Neither is typed "Bot".
		const actionsUser = user('actions-user', 65916846);
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [
					commit(actionsUser, 'GitHub Action', 'action@github.com', 'Auto-fix: Format code'),
					commit(actionsUser, 'GitHub Actions Bot', 'actions@github.com'),
					commit(user('invalid-email-address', 148100), 'github-actions', 'github-actions@github.com'),
					commit(null, 'renovate[bot]', 'bot@renovateapp.com'),
					commit(
						bob,
						'Bob B.',
						'bob@example.com',
						'Apply suggestion\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>',
					),
				],
				issueComments: [{ user: actionsUser }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map((p) => p.login),
			['bob'],
		);
	});

	it('keeps people named in the trailers of automation commits', () => {
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [commit(null, 'GitHub Action', 'action@github.com', 'Fix\n\nCo-authored-by: Erin <erin@example.org>')],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map((p) => p.email),
			['erin@example.org'],
		);
	});

	it('skips services that act through a regular user account', () => {
		const participants = collectParticipants(
			{
				pull: { user: user('imgbot[bot]', 31427850, 'Bot') },
				commits: [commit(user('ImgBotApp', 31301654), 'ImgBotApp', 'ImgBotHelp@gmail.com')],
				reviews: [{ user: carol, state: 'APPROVED' }],
				issueComments: [{ user: user('codecov-commenter', 65553080) }, { user: user('CLAassistant', 22232706) }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map((p) => p.login),
			['carol'],
		);
	});

	it('never credits the logins the user chose to ignore, however they appear', () => {
		const claude = user('claude', 81847);
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [
					commit(claude, 'Claude', 'noreply@anthropic.com'),
					commit(bob, 'Bob', 'bob@example.com', 'Fix\n\nCo-authored-by: Dave <4+dave@users.noreply.github.com>'),
				],
				issueComments: [{ user: carol }],
			},
			{ ...ALL_SOURCES, ignoredLogins: parseLoginList('@Claude\ndave, ') },
		);
		assert.deepEqual(
			participants.map((p) => p.login),
			['bob', 'carol'],
		);
	});

	it('ignores unsubmitted (pending) reviews', () => {
		const participants = collectParticipants(
			{ pull: { user: alice }, reviews: [{ user: bob, state: 'PENDING' }, { user: carol, state: 'COMMENTED' }] },
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map((p) => p.login),
			['carol'],
		);
	});

	it('includes the PR author when asked to', () => {
		const participants = collectParticipants({ pull: { user: alice } }, { ...ALL_SOURCES, includePrAuthor: true });
		assert.deepEqual(
			participants.map((p) => p.email),
			['1+alice@users.noreply.github.com'],
		);
	});

	it('credits the human reviewer of a Dependabot pull request', () => {
		// The squash commit is authored by Dependabot, so the maintainer who approved must be credited.
		const sirlouen = user('SirLouen', 5);
		const participants = collectParticipants(
			{
				pull: { user: dependabot },
				commits: [
					commit(dependabot, 'dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'),
				],
				reviews: [{ user: sirlouen, state: 'APPROVED' }],
				issueComments: [{ user: user('codecov[bot]', 22429695, 'Bot') }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map(({ login, email, sources }) => ({ login, email, sources })),
			[{ login: 'SirLouen', email: '5+SirLouen@users.noreply.github.com', sources: ['review'] }],
		);

		const { message, added } = addCoAuthorsToMessage('', participants, {
			excludeEmails: ['49699333+dependabot[bot]@users.noreply.github.com'],
		});
		assert.equal(added, 1);
		assert.equal(message, 'Co-authored-by: SirLouen <5+SirLouen@users.noreply.github.com>');
	});

	it('uses the git identity of commit authors without a GitHub account', () => {
		const [participant] = collectParticipants(
			{ pull: { user: alice }, commits: [commit(null, 'Erin', 'erin@example.org')] },
			ALL_SOURCES,
		);
		assert.deepEqual(participant, {
			login: null,
			name: 'Erin',
			email: 'erin@example.org',
			emails: ['erin@example.org'],
			sources: ['commit'],
		});
	});

	it('credits co-authors listed in commit messages', () => {
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [
					commit(
						alice,
						'Alice',
						'alice@example.com',
						'Fix bug\n\nCo-authored-by: Frank <frank@example.com>\nCo-authored-by: Bob <2+bob@users.noreply.github.com>',
					),
				],
				issueComments: [{ user: bob }],
			},
			ALL_SOURCES,
		);
		assert.deepEqual(
			participants.map(({ login, name, email, sources }) => ({ login, name, email, sources })),
			[
				{ login: null, name: 'Frank', email: 'frank@example.com', sources: ['commit'] },
				{ login: 'bob', name: 'Bob', email: '2+bob@users.noreply.github.com', sources: ['commit', 'comment'] },
			],
		);
	});

	it('merges an email-only co-author into their account once a commit links them', () => {
		const participants = collectParticipants(
			{
				pull: { user: alice },
				commits: [
					commit(alice, 'Alice', 'alice@example.com', 'One\n\nCo-authored-by: Bob <bob@example.com>'),
					commit(bob, 'Bob B.', 'bob@example.com'),
				],
				issueComments: [{ user: bob }],
			},
			ALL_SOURCES,
		);
		assert.equal(participants.length, 1);
		assert.equal(participants[0].login, 'bob');
		assert.equal(participants[0].name, 'Bob');
		assert.deepEqual(participants[0].emails, ['bob@example.com', '2+bob@users.noreply.github.com']);
	});

	it('only reads the enabled sources', () => {
		const activity = {
			pull: { user: alice },
			commits: [commit(bob, 'Bob', 'bob@example.com')],
			reviews: [{ user: carol }],
			issueComments: [{ user: dave }],
		};
		const options = {
			includeCommitAuthors: false,
			includeReviewers: false,
			includeCommenters: true,
			includePrAuthor: false,
		};
		assert.deepEqual(
			collectParticipants(activity, options).map((p) => p.login),
			['dave'],
		);
	});
});

describe('parseLoginList', () => {
	it('accepts lines, commas, spaces and a leading @', () => {
		assert.deepEqual(parseLoginList(' @My-CI-User\nclaude,  renovate-bot \n\n'), ['my-ci-user', 'claude', 'renovate-bot']);
		assert.deepEqual(parseLoginList(undefined), []);
	});
});

describe('applyDisplayNames', () => {
	it('replaces names with profile names, case-insensitively', () => {
		const participants = [
			{ login: 'Bob', name: 'Bob', email: 'b@x', emails: ['b@x'], sources: [] },
			{ login: null, name: 'Erin', email: 'e@x', emails: ['e@x'], sources: [] },
		];
		const named = applyDisplayNames(participants, new Map([['bob', 'Bob Builder']]));
		assert.deepEqual(
			named.map((p) => p.name),
			['Bob Builder', 'Erin'],
		);
	});
});

describe('formatCoAuthorTrailer', () => {
	it('formats a trailer and strips characters that would break it', () => {
		assert.equal(
			formatCoAuthorTrailer({ name: 'Bob <the>\nBuilder', email: 'bob@example.com' }),
			'Co-authored-by: Bob the Builder <bob@example.com>',
		);
		assert.equal(formatCoAuthorTrailer({ name: ' ', email: 'x@y.z' }), 'Co-authored-by: x@y.z <x@y.z>');
	});
});

describe('parseCoAuthorTrailers', () => {
	it('finds trailers regardless of case', () => {
		assert.deepEqual(parseCoAuthorTrailers('Title\n\nco-authored-by: A <a@x>\nCo-Authored-By:B <b@x>\nNot: c <c@x>'), [
			{ name: 'A', email: 'a@x' },
			{ name: 'B', email: 'b@x' },
		]);
	});
});

describe('appendTrailers', () => {
	it('starts a new paragraph after prose', () => {
		assert.equal(appendTrailers('Some text\n', ['Co-authored-by: A <a@x>']), 'Some text\n\nCo-authored-by: A <a@x>');
	});

	it('extends an existing trailer block', () => {
		assert.equal(
			appendTrailers('* Commit\n\nSigned-off-by: A <a@x>', ['Co-authored-by: B <b@x>']),
			'* Commit\n\nSigned-off-by: A <a@x>\nCo-authored-by: B <b@x>',
		);
	});

	it('does not treat a "Note: …" line as a trailer', () => {
		assert.equal(appendTrailers('Note: important', ['Co-authored-by: B <b@x>']), 'Note: important\n\nCo-authored-by: B <b@x>');
	});

	it('handles an empty message and no trailers', () => {
		assert.equal(appendTrailers('  \n', ['Co-authored-by: B <b@x>']), 'Co-authored-by: B <b@x>');
		assert.equal(appendTrailers('Unchanged', []), 'Unchanged');
	});
});

describe('addCoAuthorsToMessage', () => {
	const participant = (login, email, extraEmails = []) => ({
		login,
		name: login ?? email,
		email,
		emails: [email, ...extraEmails],
		sources: ['comment'],
	});

	it('appends only people who are not credited yet', () => {
		const message = '* Fix\n\nCo-authored-by: Bob B. <bob@example.com>';
		const result = addCoAuthorsToMessage(message, [
			participant('bob', '2+bob@users.noreply.github.com', ['bob@example.com']),
			participant('carol', '3+carol@users.noreply.github.com'),
		]);
		assert.deepEqual(result, {
			message: `${message}\nCo-authored-by: carol <3+carol@users.noreply.github.com>`,
			added: 1,
			skipped: 1,
		});
	});

	it('recognizes existing noreply trailers by login, whatever their user ID prefix', () => {
		const result = addCoAuthorsToMessage('Co-authored-by: Carol <carol@users.noreply.github.com>', [
			participant('Carol', '3+carol@users.noreply.github.com'),
		]);
		assert.equal(result.added, 0);
		assert.equal(result.skipped, 1);
	});

	it('never adds excluded emails, such as the merge commit author', () => {
		const result = addCoAuthorsToMessage('', [participant('dave', '4+dave@users.noreply.github.com')], {
			excludeEmails: ['4+dave@users.noreply.github.com'],
		});
		assert.deepEqual(result, { message: '', added: 0, skipped: 1 });
	});

	it('is idempotent', () => {
		const people = [participant('carol', '3+carol@users.noreply.github.com')];
		const first = addCoAuthorsToMessage('Body', people);
		const second = addCoAuthorsToMessage(first.message, people);
		assert.equal(second.message, first.message);
		assert.equal(second.added, 0);
	});
});
