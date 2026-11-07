'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SpinupWpApi, errorMessageFrom } = require('../lib/main/SpinupWpApi');

const quiet = { info() {}, warn() {}, error() {} };

/** A fetch stand-in that answers from `routes` ({ 'METHOD /path': (url, init) => [status, body, headers?] }) and records calls. */
function fakeFetch(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const u = new URL(url);
		const key = `${init.method} ${u.pathname}`;
		calls.push({ key, url: u, init });
		const route = routes[key];
		const [status, body, headers = {}] = route ? route(u, init, calls) : [404, { message: 'Not Found' }];
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body),
			headers: { get: (name) => headers[name.toLowerCase()] || null },
		};
	};
	return { fetchImpl, calls };
}

/** A page in SpinupWP's list envelope: { data, pagination: { previous, next, per_page, count } }. */
const page = (data, next = null, count = data.length) => [200, { data, pagination: { previous: null, next, per_page: 100, count } }];

test('sends the token as a bearer token to api.spinupwp.app and counts sites and servers', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'GET /v1/sites': () => page([{ id: 1 }, { id: 2 }]),
		'GET /v1/servers': () => page([{ id: 9 }]),
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.deepEqual(await api.validate(), { sites: 2, servers: 1 });
	assert.equal(calls[0].url.origin, 'https://api.spinupwp.app');
	calls.forEach((c) => {
		assert.equal(c.init.headers.Authorization, 'Bearer tok');
		assert.equal(c.init.headers.Accept, 'application/json');
		assert.equal(c.url.searchParams.get('limit'), '100');
	});
});

test('requires a token', () => {
	assert.throws(() => new SpinupWpApi({ apiKey: '' }), /API token is required/);
});

test('follows pagination until `next` is empty', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'GET /v1/sites': (u) => (u.searchParams.get('page') === '1'
			? page([{ id: 1 }], 'https://api.spinupwp.app/v1/sites?page=2', 2)
			: page([{ id: 2 }], null, 2)),
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.deepEqual((await api.listSites()).map((s) => s.id), [1, 2]);
	assert.deepEqual(calls.map((c) => c.url.searchParams.get('page')), ['1', '2']);
});

test('stops on an empty page even without pagination data', async () => {
	const { fetchImpl, calls } = fakeFetch({ 'GET /v1/servers': () => [200, { data: [] }] });
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.deepEqual(await api.listServers(), []);
	assert.equal(calls.length, 1);
});

test('getSite and getServer unwrap `data`, and answer null for an unknown id', async () => {
	const { fetchImpl } = fakeFetch({
		'GET /v1/sites/5': () => [200, { data: { id: 5, domain: 'a.example', site_user: 'a' } }],
		'GET /v1/servers/9': () => [200, { data: { id: 9, ip_address: '203.0.113.10', ssh_port: 22 } }],
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.equal((await api.getSite(5)).site_user, 'a');
	assert.equal((await api.getServer(9)).ip_address, '203.0.113.10');
	assert.equal(await api.getSite(6), null);
});

test('purges the page and object caches with POSTs and returns the event ids', async () => {
	const { fetchImpl, calls } = fakeFetch({
		'POST /v1/sites/5/page-cache/purge': () => [200, { event_id: 77 }],
		'POST /v1/sites/5/object-cache/purge': () => [200, { event_id: 78 }],
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.equal(await api.purgePageCache(5), 77);
	assert.equal(await api.purgeObjectCache(5), 78);
	assert.deepEqual(calls.map((c) => c.key), ['POST /v1/sites/5/page-cache/purge', 'POST /v1/sites/5/object-cache/purge']);
});

test('waitForEvent polls until the event is deployed, and throws with its output when it fails', async () => {
	let n = 0;
	const { fetchImpl } = fakeFetch({
		'GET /v1/events/1': () => [200, { data: { id: 1, status: (n += 1) < 3 ? 'updating' : 'deployed' } }],
		'GET /v1/events/2': () => [200, { data: { id: 2, name: 'Purge page cache', status: 'failed', output: 'cache daemon not running' } }],
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	const done = await api.waitForEvent(1, { intervalMs: 1, timeoutMs: 5000 });
	assert.equal(done.status, 'deployed');
	assert.equal(n, 3);
	await assert.rejects(api.waitForEvent(2, { intervalMs: 1 }), /SpinupWP reported: cache daemon not running/);
	assert.equal(await api.waitForEvent(null), null);
});

test('waitForEvent gives up quietly after the timeout, returning the last state', async () => {
	const { fetchImpl } = fakeFetch({ 'GET /v1/events/3': () => [200, { data: { id: 3, status: 'queued' } }] });
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	const last = await api.waitForEvent(3, { intervalMs: 5, timeoutMs: 1 });
	assert.equal(last.status, 'queued');
});

test('retries after a 429, honouring Retry-After', async () => {
	let n = 0;
	const { fetchImpl, calls } = fakeFetch({
		'GET /v1/sites/5': () => ((n += 1) === 1 ? [429, { message: 'Too Many Attempts.' }, { 'retry-after': '0.01' }] : [200, { data: { id: 5 } }]),
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	assert.equal((await api.getSite(5)).id, 5);
	assert.equal(calls.length, 2);
});

test('a rejected token says where to make a new one; 403 says which token to use', async () => {
	const { fetchImpl } = fakeFetch({
		'GET /v1/sites': () => [401, { message: 'Unauthenticated.' }],
		'GET /v1/servers': () => [403, { message: 'This action is unauthorized.' }],
	});
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	await assert.rejects(api.listSites(), (e) => e.status === 401 && /My Account → API Tokens/.test(e.message));
	await assert.rejects(api.listServers(), (e) => e.status === 403 && /team token/.test(e.message));
});

test('network failures say what they mean', async () => {
	const fetchImpl = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
	const api = new SpinupWpApi({ apiKey: 'tok', fetchImpl, logger: quiet });
	await assert.rejects(api.listSites(), /Could not reach SpinupWP's API \(ENOTFOUND\)/);
});

test('errorMessageFrom reads Laravel validation errors, then message', () => {
	assert.equal(errorMessageFrom({ message: 'The given data was invalid.', errors: { domain: ['The domain is taken.'] } }, 422), 'The domain is taken.');
	assert.equal(errorMessageFrom({ message: 'Server error' }, 500), 'Server error');
	assert.equal(errorMessageFrom(null, 502), 'SpinupWP API request failed (HTTP 502)');
});
