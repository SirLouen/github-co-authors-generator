// Minimal GitHub REST + GraphQL client used by the service worker and the settings page.

export const API_URL = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 30;

export class GitHubApiError extends Error {
	/**
	 * @param {string} message
	 * @param {object} details
	 * @param {number} details.status HTTP status (0 for network errors).
	 * @param {'unauthorized' | 'rate_limited' | 'sso_required' | 'forbidden' | 'not_found' | 'network' | 'http'} details.code
	 * @param {boolean} details.authenticated Whether the failing request carried a token.
	 * @param {number | null} [details.resetAt] When the rate limit resets (ms since epoch).
	 */
	constructor(message, { status, code, authenticated, resetAt = null }) {
		super(message);
		this.name = 'GitHubApiError';
		this.status = status;
		this.code = code;
		this.authenticated = authenticated;
		this.resetAt = resetAt;
	}
}

/**
 * @typedef {object} RateLimit
 * @property {number} limit
 * @property {number} remaining
 * @property {number} resetAt Milliseconds since epoch.
 */

/** @param {Headers} headers @returns {RateLimit | null} */
export function readRateLimit(headers) {
	const limit = headers.get('x-ratelimit-limit');
	const remaining = headers.get('x-ratelimit-remaining');
	const reset = headers.get('x-ratelimit-reset');
	if (limit === null || remaining === null || reset === null) return null;
	return { limit: Number(limit), remaining: Number(remaining), resetAt: Number(reset) * 1000 };
}

/** Returns the URL of the `rel="next"` page from a `Link` header, if any. */
export function nextPageUrl(linkHeader) {
	if (!linkHeader) return null;
	for (const part of linkHeader.split(',')) {
		const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
		if (match) return match[1];
	}
	return null;
}

/**
 * @param {object} [options]
 * @param {string | null} [options.token] Token used for authenticated requests; anonymous when empty.
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createGitHubClient({ token = null, fetchImpl = (...args) => fetch(...args) } = {}) {
	const authenticated = Boolean(token);
	/** @type {RateLimit | null} */
	let rateLimit = null;

	/**
	 * Remembers the REST rate limit. GraphQL has its own budget, counted in points, so its headers
	 * are ignored. Parallel responses arrive in any order: the newest window wins, and within a
	 * window the lowest remaining count.
	 * @param {Headers} headers
	 */
	function trackRateLimit(headers) {
		const limit = readRateLimit(headers);
		if (!limit || headers.get('x-ratelimit-resource') === 'graphql') return;
		const replaces =
			!rateLimit ||
			limit.resetAt > rateLimit.resetAt ||
			(limit.resetAt === rateLimit.resetAt && limit.remaining < rateLimit.remaining);
		if (replaces) rateLimit = limit;
	}

	/** @param {string} pathOrUrl @param {RequestInit} [init] */
	async function send(pathOrUrl, init = {}) {
		const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${API_URL}${pathOrUrl}`;
		const headers = {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...init.headers,
		};
		if (token) headers.Authorization = `Bearer ${token}`;

		let response;
		try {
			response = await fetchImpl(url, {
				...init,
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new GitHubApiError(`Could not reach GitHub: ${error.message}`, {
				status: 0,
				code: 'network',
				authenticated,
			});
		}

		trackRateLimit(response.headers);
		if (!response.ok) throw await toApiError(response, authenticated);
		return response;
	}

	/** GET a single resource. */
	async function request(path) {
		const response = await send(path);
		return response.json();
	}

	/**
	 * GET every page of a list endpoint.
	 * @param {string} path
	 * @param {(page: any) => any[]} [getItems] Picks the items out of each page, for endpoints that
	 *   return an object rather than an array.
	 */
	async function paginate(path, getItems = (page) => page) {
		const separator = path.includes('?') ? '&' : '?';
		let url = `${path}${separator}per_page=100`;
		const items = [];
		for (let page = 0; url && page < MAX_PAGES; page++) {
			const response = await send(url);
			items.push(...(getItems(await response.json()) ?? []));
			url = nextPageUrl(response.headers.get('link'));
		}
		return items;
	}

	/** POST a GraphQL query. GraphQL always requires a token. */
	async function graphql(query, variables = {}) {
		const response = await send('/graphql', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query, variables }),
		});
		return response.json();
	}

	return {
		authenticated,
		request,
		paginate,
		graphql,
		get rateLimit() {
			return rateLimit;
		},
	};
}

/** @param {Response} response @param {boolean} authenticated */
async function toApiError(response, authenticated) {
	let apiMessage = '';
	try {
		apiMessage = (await response.json())?.message ?? '';
	} catch {
		// Body was not JSON.
	}
	const status = response.status;
	const headers = response.headers;
	const details = { status, authenticated };

	if (status === 401) {
		return new GitHubApiError('GitHub rejected the saved token. Sign in again from the extension settings.', {
			...details,
			code: 'unauthorized',
		});
	}

	const limit = readRateLimit(headers);
	const isRateLimited =
		status === 429 || (status === 403 && (limit?.remaining === 0 || /rate limit/i.test(apiMessage)));
	if (isRateLimited) {
		const retryAfter = Number(headers.get('retry-after'));
		const resetAt = retryAfter > 0 ? Date.now() + retryAfter * 1000 : (limit?.resetAt ?? null);
		return new GitHubApiError(apiMessage || 'GitHub API rate limit exceeded.', {
			...details,
			code: 'rate_limited',
			resetAt,
		});
	}

	if (status === 403 && headers.get('x-github-sso')) {
		return new GitHubApiError(
			'Your token must be authorized for this organization’s SAML single sign-on.',
			{ ...details, code: 'sso_required' },
		);
	}
	if (status === 403) {
		return new GitHubApiError(apiMessage || 'GitHub denied access to this resource.', {
			...details,
			code: 'forbidden',
		});
	}
	if (status === 404) {
		return new GitHubApiError(
			authenticated
				? 'Pull request not found. If the repository is private, make sure your token can read it.'
				: 'Pull request not found. If the repository is private, sign in from the extension settings.',
			{ ...details, code: 'not_found' },
		);
	}
	return new GitHubApiError(apiMessage || `GitHub API request failed with status ${status}.`, {
		...details,
		code: 'http',
	});
}
