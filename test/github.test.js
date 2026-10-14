import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGitHubClient, GitHubApiError, nextPageUrl } from '../extension/lib/github.js';

const RATE_HEADERS = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1700000000' };

/** A fetch stub that answers from a list of [urlFragment, response] pairs and records requests. */
function fakeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		const route = routes.find(([fragment]) => url.includes(fragment));
		if (!route) throw new Error(`Unexpected request to ${url}`);
		const { status = 200, body = {}, headers = {} } = route[1];
		return new Response(JSON.stringify(body), { status, headers: { ...RATE_HEADERS, ...headers } });
	};
	return { fetchImpl, calls };
}

describe('createGitHubClient', () => {
	it('sends the token as a bearer token', async () => {
		const { fetchImpl, calls } = fakeFetch([['/user', { body: { login: 'alice' } }]]);
		const client = createGitHubClient({ token: 'secret', fetchImpl });
		assert.deepEqual(await client.request('/user'), { login: 'alice' });
		assert.equal(calls[0].url, 'https://api.github.com/user');
		assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
		assert.equal(client.authenticated, true);
		assert.deepEqual(client.rateLimit, { limit: 5000, remaining: 4990, resetAt: 1_700_000_000_000 });
	});

	it('makes anonymous requests without a token', async () => {
		const { fetchImpl, calls } = fakeFetch([['/rate_limit', { body: {} }]]);
		const client = createGitHubClient({ fetchImpl });
		await client.request('/rate_limit');
		assert.equal('Authorization' in calls[0].init.headers, false);
		assert.equal(client.authenticated, false);
	});

	it('follows pagination links', async () => {
		const { fetchImpl, calls } = fakeFetch([
			['page=2', { body: [{ id: 3 }] }],
			[
				'/comments',
				{
					body: [{ id: 1 }, { id: 2 }],
					headers: { link: '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next"' },
				},
			],
		]);
		const items = await createGitHubClient({ token: 't', fetchImpl }).paginate('/repos/o/r/issues/1/comments');
		assert.deepEqual(items, [{ id: 1 }, { id: 2 }, { id: 3 }]);
		assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/issues/1/comments?per_page=100');
	});

	it('reports the REST rate limit, not the separate GraphQL budget', async () => {
		const { fetchImpl } = fakeFetch([
			['/graphql', { body: { data: {} }, headers: { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '0' } }],
			['/newer', { body: {}, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4980' } }],
			['/older', { body: {}, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990' } }],
		]);
		const client = createGitHubClient({ token: 't', fetchImpl });
		await client.request('/newer');
		await client.request('/older'); // A parallel response that arrived late with an older count.
		assert.equal(client.rateLimit.remaining, 4980);
		await client.graphql('query { x }');
		assert.equal(client.rateLimit.remaining, 4980);
	});

	it('paginates endpoints that wrap their items in an object', async () => {
		const { fetchImpl } = fakeFetch([
			['page=2', { body: { commits: [{ sha: 'c' }] } }],
			[
				'/compare/',
				{
					body: { commits: [{ sha: 'a' }, { sha: 'b' }], files: [] },
					headers: { link: '<https://api.github.com/repos/o/r/compare/x...y?per_page=100&page=2>; rel="next"' },
				},
			],
		]);
		const commits = await createGitHubClient({ token: 't', fetchImpl }).paginate(
			'/repos/o/r/compare/x...y',
			(page) => page.commits,
		);
		assert.deepEqual(
			commits.map((c) => c.sha),
			['a', 'b', 'c'],
		);
	});

	it('posts GraphQL queries', async () => {
		const { fetchImpl, calls } = fakeFetch([['/graphql', { body: { data: { u0: { login: 'a', name: 'A' } } } }]]);
		const result = await createGitHubClient({ token: 't', fetchImpl }).graphql('query { x }', { l0: 'a' });
		assert.deepEqual(result.data.u0, { login: 'a', name: 'A' });
		assert.equal(calls[0].init.method, 'POST');
		assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'query { x }', variables: { l0: 'a' } });
	});

	it('reports primary rate limits with their reset time', async () => {
		const { fetchImpl } = fakeFetch([
			[
				'/pulls/1',
				{
					status: 403,
					body: { message: 'API rate limit exceeded for 104.28.192.82.' },
					headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
				},
			],
		]);
		await assert.rejects(createGitHubClient({ fetchImpl }).request('/repos/o/r/pulls/1'), (error) => {
			assert.ok(error instanceof GitHubApiError);
			assert.equal(error.code, 'rate_limited');
			assert.equal(error.authenticated, false);
			assert.equal(error.resetAt, 1_800_000_000_000);
			return true;
		});
	});

	it('reports secondary rate limits using Retry-After', async () => {
		const { fetchImpl } = fakeFetch([['/x', { status: 429, body: {}, headers: { 'retry-after': '60' } }]]);
		const before = Date.now();
		await assert.rejects(createGitHubClient({ token: 't', fetchImpl }).request('/x'), (error) => {
			assert.equal(error.code, 'rate_limited');
			assert.ok(error.resetAt >= before + 60_000);
			return true;
		});
	});

	it('maps authentication, SSO and missing resources to specific codes', async () => {
		const { fetchImpl } = fakeFetch([
			['/unauthorized', { status: 401, body: { message: 'Bad credentials' } }],
			['/sso', { status: 403, body: { message: 'Resource protected' }, headers: { 'x-github-sso': 'required; url=x' } }],
			['/missing', { status: 404, body: { message: 'Not Found' } }],
		]);
		const client = createGitHubClient({ token: 't', fetchImpl });
		await assert.rejects(client.request('/unauthorized'), { code: 'unauthorized', status: 401 });
		await assert.rejects(client.request('/sso'), { code: 'sso_required', status: 403 });
		await assert.rejects(client.request('/missing'), { code: 'not_found', status: 404 });
	});

	it('wraps network failures', async () => {
		const client = createGitHubClient({
			fetchImpl: async () => {
				throw new TypeError('Failed to fetch');
			},
		});
		await assert.rejects(client.request('/x'), { code: 'network', status: 0 });
	});
});

describe('nextPageUrl', () => {
	it('picks the next link among several', () => {
		const header =
			'<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
		assert.equal(nextPageUrl(header), 'https://api.github.com/x?page=3');
		assert.equal(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"'), null);
		assert.equal(nextPageUrl(null), null);
	});
});
