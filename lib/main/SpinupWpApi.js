'use strict';

const { SPINUPWP_API_BASE } = require('../constants');

class SpinupWpApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'SpinupWpApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Largest page the list endpoints accept. */
const PER_PAGE = 100;
/** Stops a misbehaving paginated listing from looping forever. */
const MAX_PAGES = 100;

/** Where API tokens are created. */
const API_TOKENS_PAGE = 'SpinupWP → My Account → API Tokens';

/**
 * Pulls the most useful human-readable message out of a SpinupWP error body. SpinupWP (Laravel) answers
 * `{ message, errors: { field: [messages] } }`.
 */
function errorMessageFrom(body, status) {
	if (body && typeof body === 'object') {
		const errors = Array.isArray(body.errors) ? body.errors : body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : [];
		const messages = errors.flat().map((e) => (typeof e === 'string' ? e : e && (e.message || e.code))).filter(Boolean);
		if (messages.length) return messages.join(' ');
		if (typeof body.message === 'string' && body.message) return body.message;
		if (typeof body.error === 'string' && body.error) return body.error;
	}
	return `SpinupWP API request failed (HTTP ${status})`;
}

/** `data` from a `{ data: [...] }` envelope, or [] when it is missing or not a list. */
const listFrom = (body) => (body && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []);

/** `data` from a `{ data: {...} }` envelope, or null. */
const objectFrom = (body) => (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null);

/** Event states SpinupWP reports while an action is still running. */
const PENDING_EVENT_STATES = new Set(['queued', 'creating', 'updating', 'deleting']);

/**
 * Thin client for the SpinupWP API (https://api.spinupwp.com, beta). A personal or team API token is sent as a bearer
 * token. The API lists servers (IP address, SSH port) and sites (domain, site user, additional domains) and purges a
 * site's page and object caches. It can't add SSH keys to an account: the key is added in SpinupWP and attached to
 * the site user there. Files and the database move over SSH as the site user.
 */
class SpinupWpApi {
	constructor({ apiKey, fetchImpl = globalThis.fetch, base = SPINUPWP_API_BASE, logger = console }) {
		if (!apiKey) throw new SpinupWpApiError('A SpinupWP API token is required.', 0);
		this._apiKey = apiKey;
		this._fetch = fetchImpl;
		this._base = base;
		this._logger = logger;
	}

	/** Checks the token and counts what it can see: { sites, servers }. */
	async validate() {
		const [sites, servers] = await Promise.all([this.listSites(), this.listServers()]);
		return { sites: sites.length, servers: servers.length };
	}

	/**
	 * Every site the token can see, all pages: { id, server_id, domain, additional_domains, site_user, php_version,
	 * public_folder, is_wordpress, page_cache, status, … }.
	 */
	listSites() {
		return this._listAll('/v1/sites');
	}

	/** Every server the token can see: { id, name, ip_address, ssh_port, provider_name, connection_status, status, … }. */
	listServers() {
		return this._listAll('/v1/servers');
	}

	/** One site, or null when SpinupWP doesn't know it (deleted, or another team's). */
	getSite(siteId) {
		return this._getOne(`/v1/sites/${encodeURIComponent(siteId)}`);
	}

	/** One server, or null. */
	getServer(serverId) {
		return this._getOne(`/v1/servers/${encodeURIComponent(serverId)}`);
	}

	/** Purges the site's Nginx page cache. Returns the event id (the purge runs in the background). */
	async purgePageCache(siteId) {
		const { data } = await this.request('POST', `/v1/sites/${encodeURIComponent(siteId)}/page-cache/purge`);
		return data && data.event_id !== undefined ? data.event_id : null;
	}

	/** Purges the site's Redis object cache. Returns the event id. */
	async purgeObjectCache(siteId) {
		const { data } = await this.request('POST', `/v1/sites/${encodeURIComponent(siteId)}/object-cache/purge`);
		return data && data.event_id !== undefined ? data.event_id : null;
	}

	/** One event: { id, name, status, output, … }, or null. */
	getEvent(eventId) {
		return this._getOne(`/v1/events/${encodeURIComponent(eventId)}`);
	}

	/**
	 * Waits for an event to finish: resolves with it once it is `deployed`, throws when it `failed`, and resolves with
	 * the last state seen when it is still running after `timeoutMs` (the action carries on in SpinupWP).
	 */
	async waitForEvent(eventId, { timeoutMs = 60 * 1000, intervalMs = 3000 } = {}) {
		if (eventId === null || eventId === undefined) return null;
		const deadline = Date.now() + timeoutMs;
		let event = null;
		for (;;) {
			event = await this.getEvent(eventId);
			const status = event && String(event.status || '').toLowerCase();
			if (status === 'failed') throw new SpinupWpApiError(`SpinupWP reported: ${(event.output && String(event.output).trim()) || `${event.name || 'the action'} failed`}`, 0, event);
			if (!event || !PENDING_EVENT_STATES.has(status) || Date.now() + intervalMs > deadline) return event;
			await sleep(intervalMs);
		}
	}

	async _getOne(path) {
		try {
			const { data } = await this.request('GET', path);
			return objectFrom(data);
		} catch (e) {
			if (e.status === 404) return null;
			throw e;
		}
	}

	async _listAll(path) {
		const items = [];
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const { data } = await this.request('GET', path, { query: { page, limit: PER_PAGE } });
			const batch = listFrom(data);
			items.push(...batch);
			const next = data && data.pagination ? data.pagination.next : undefined;
			if (!batch.length || (next !== undefined ? !next : batch.length < PER_PAGE)) break;
		}
		return items;
	}

	_networkError(e) {
		// fetch() only says "fetch failed" when the network is down or DNS fails; say what that means.
		const cause = e && e.cause && (e.cause.code || e.cause.message);
		return new SpinupWpApiError(`Could not reach SpinupWP's API (${cause || e.message}). Check your internet connection and try again.`, 0, null);
	}

	async request(method, path, { query, form } = {}, attempt = 0) {
		const url = new URL(`${this._base}${path}`);
		if (query) {
			Object.entries(query).forEach(([k, v]) => {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			});
		}
		const headers = { Authorization: `Bearer ${this._apiKey}`, Accept: 'application/json' };
		let body;
		if (form) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			body = new URLSearchParams(form).toString();
		}
		let res;
		try {
			res = await this._fetch(url.toString(), { method, headers, body });
		} catch (e) {
			throw this._networkError(e);
		}
		const data = await res.json().catch(() => null);
		if (res.status === 429 && attempt < 4) {
			const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 ** attempt * 5;
			this._logger.warn(`SpinupWP API rate limited; retrying in ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			return this.request(method, path, { query, form }, attempt + 1);
		}
		if (res.status === 401) {
			throw new SpinupWpApiError(`SpinupWP doesn't accept this API token. Create a new one in ${API_TOKENS_PAGE}, then connect again.`, 401, data);
		}
		if (res.status === 403) {
			throw new SpinupWpApiError(`This API token isn't allowed to ${method} ${path}. Use a token from ${API_TOKENS_PAGE} (or a team owner's `
				+ 'or admin\'s team token).', 403, data);
		}
		if (!res.ok) throw new SpinupWpApiError(errorMessageFrom(data, res.status), res.status, data);
		return { status: res.status, data: data || {} };
	}
}

module.exports = { SpinupWpApi, SpinupWpApiError, errorMessageFrom, API_TOKENS_PAGE };
