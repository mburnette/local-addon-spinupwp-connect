'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. The SpinupWP API is
 * a fake global fetch answering with the shapes seen on a the API reference (api.spinupwp.com, 2026-11-07); SSH is stubbed at
 * SyncService.transportFor (a fake transport) and at SyncService.discoverRemote / pull.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService } = require('../lib/main/SyncService');
const { TransportError } = require('../lib/main/transport');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

const REMOTE = {
	remotePath: '/sites/shop.example/files',
	privateDir: '/sites/shop.example/.spinupwp-connect/files-123',
	wp: 'wp',
	hasWpCli: true,
	hasRsync: true,
	hasPhp: true,
	nested: [],
	managed: [],
};

const TOKEN = 'good-token';
const server = (id, extra = {}) => ({
	id,
	name: `server${id}`,
	provider_name: 'DigitalOcean',
	ip_address: `203.0.113.${id}`,
	ssh_port: 22,
	connection_status: 'connected',
	status: 'provisioned',
	...extra,
});
const SERVERS = [server(1, { name: 'web-1' }), server(2, { name: 'web-2', ssh_port: 2222 })];
const site = (id, extra = {}) => ({
	id,
	server_id: 1,
	domain: `site${id}.example`,
	additional_domains: [],
	site_user: `site${id}`,
	php_version: '8.3',
	public_folder: '/',
	is_wordpress: true,
	https: { enabled: true },
	status: 'deployed',
	disabled_at: null,
	...extra,
});
const SHOP = 101;
const SITES = [
	site(SHOP, {
		domain: 'shop.example',
		site_user: 'shop',
		subdomain: { enabled: true, url: 'https://abc123xyz.qal.spinupwp.site' },
		additional_domains: [
			{ id: 1, domain: 'www.shop.example', redirect: { enabled: true } },
			{ id: 2, domain: 'old-shop.example', redirect: { enabled: false } },
		],
	}),
	site(102, { server_id: 2, domain: 'blog.example', site_user: 'blog', public_folder: '/public' }),
	site(103, { disabled_at: '2026-11-01T00:00:00Z' }),
	site(104, { status: 'creating' }),
	site(105, { is_wordpress: false, domain: 'static.example' }),
];

/** Fake SpinupWP API. The `api` flags steer it; every request is recorded in `calls`. */
const api = {};
const resetApi = () => Object.assign(api, { perPage: 100 });
resetApi();
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => null } });
const listPage = (items, u) => {
	const page = Number(u.searchParams.get('page')) || 1;
	const perPage = Math.min(api.perPage, Number(u.searchParams.get('limit')) || 10);
	const data = items.slice((page - 1) * perPage, page * perPage);
	const next = page * perPage < items.length ? `${u.origin}${u.pathname}?page=${page + 1}` : null;
	return json(200, { data, pagination: { previous: null, next, per_page: perPage, count: items.length } });
};
globalThis.fetch = async (url, init) => {
	const u = new URL(url);
	const key = `${init.method} ${u.pathname}`;
	calls.push(['api', key, u.search]);
	if (init.headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Unauthenticated.' });
	if (key === 'GET /v1/sites') return listPage(SITES, u);
	if (key === 'GET /v1/servers') return listPage(SERVERS, u);
	let m = /^GET \/v1\/sites\/(\d+)$/.exec(key);
	if (m) {
		const found = SITES.find((x) => String(x.id) === m[1]);
		return found ? json(200, { data: found }) : json(404, { message: 'Not Found' });
	}
	m = /^GET \/v1\/servers\/(\d+)$/.exec(key);
	if (m) {
		const found = SERVERS.find((x) => String(x.id) === m[1]);
		return found ? json(200, { data: found }) : json(404, { message: 'Not Found' });
	}
	return json(404, { message: 'Not Found' });
};

/** How SSH logins go: (transport) -> true to accept, or a TransportError to throw. */
let acceptLogin;

SyncService.prototype.transportFor = function transportFor(link) {
	return {
		username: link.username,
		host: link.host,
		port: link.port,
		password: link.authType === 'password' ? link.password : null,
		close: async () => {},
		exec: async () => ({ code: 0, stdout: '', stderr: '' }),
	};
};
let discoverBehaviour = async () => REMOTE;
SyncService.prototype.discoverRemote = async function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, transport.port, transport.password, hints]);
	const outcome = acceptLogin(transport);
	if (outcome instanceof Error) throw outcome;
	if (!outcome) {
		throw new TransportError(`SpinupWP refused the ${transport.password ? 'password' : 'SSH key'} for ${transport.username}@${transport.host}`, 255, 'Permission denied (publickey,password).');
	}
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);
const apiCalls = () => calls.filter((c) => c[0] === 'api').map((c) => c[1]);
const discovers = () => calls.filter((c) => c[0] === 'discover').map((c) => c.slice(1));
const settingsFile = () => fs.readFileSync(path.join(userDataPath, 'spinupwp-connect', 'settings.json'), 'utf8');
const reset = () => {
	calls.length = 0;
	resetApi();
	acceptLogin = () => true;
	discoverBehaviour = async () => REMOTE;
};

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('a rejected API token is reported and nothing is stored', async () => {
	reset();
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'bad' }), /doesn't accept this API token.*My Account → API Tokens/);
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ apiKey: ' \n' }), /Paste an API token/);
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
});

test('connecting validates the token, counts sites and servers and keeps the token out of the renderer', async () => {
	reset();
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: ' good-​token\n' });
	assert.deepEqual(Object.keys(state.account).sort(), ['connectedAt', 'servers', 'sites']);
	assert.equal(state.account.sites, SITES.length);
	assert.equal(state.account.servers, SERVERS.length);
	assert.ok(!settingsFile().includes(TOKEN), 'the token is stored encrypted');
	assert.ok(!JSON.stringify(state).includes(TOKEN));
	assert.deepEqual(apiCalls().sort(), ['GET /v1/servers', 'GET /v1/sites']);
});

test('lists sites grouped by server; disabled, unfinished and non-WordPress ones cannot be linked', async () => {
	reset();
	const choices = await handlers[IPC.LIST_SITES]();
	assert.deepEqual(choices.map((c) => [c.id, c.group, c.domain, c.siteUser, c.linkable, c.reason]), [
		['101', 'web-1', 'shop.example', 'shop', true, null],
		['103', 'web-1', 'site103.example', 'site103', false, 'disabled'],
		['104', 'web-1', 'site104.example', 'site104', false, 'creating'],
		['105', 'web-1', 'static.example', 'site105', false, 'not WordPress'],
		['102', 'web-2', 'blog.example', 'blog', true, null],
	]);
	assert.equal(choices[0].url, 'https://shop.example/');
});

test('follows pagination when listing', async () => {
	reset();
	api.perPage = 2;
	const choices = await handlers[IPC.LIST_SITES]();
	assert.equal(choices.length, SITES.length);
	assert.equal(apiCalls().filter((c) => c === 'GET /v1/sites').length, 3);
});

test('links a site as its site user, on the server\'s IP and SSH port, in /sites/<domain>/files', async () => {
	reset();
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', id: String(SHOP), progressId: 'p1' });
	const { link } = state;
	assert.equal(link.mode, 'account');
	assert.equal(link.host, '203.0.113.1');
	assert.equal(link.port, 22);
	assert.equal(link.username, 'shop');
	assert.equal(link.spinupwpSiteId, '101');
	assert.equal(link.spinupwpServerId, '1');
	assert.equal(link.serverName, 'web-1');
	assert.equal(link.domain, 'shop.example');
	assert.equal(link.label, 'shop.example');
	assert.equal(link.authType, 'key');
	assert.equal(link.webRoot, '/sites/shop.example/files');
	assert.deepEqual(link.altDomains, ['www.shop.example', 'old-shop.example', 'abc123xyz.qal.spinupwp.site'], 'additional domains, the preview address, the www twin');
	assert.equal(link.remotePath, '/sites/shop.example/files');
	const [d] = discovers();
	assert.deepEqual(d.slice(0, 4), ['shop', '203.0.113.1', 22, null]);
	assert.equal(d[4].remotePath, '/sites/shop.example/files', 'only the site\'s own folder is searched');
	assert.deepEqual(apiCalls(), ['GET /v1/sites/101', 'GET /v1/servers/1']);
	assert.ok(calls.some((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS && c[2] === 'p1'));
});

test('a custom SSH port and a public folder are respected', async () => {
	reset();
	const { link } = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 's1', id: '102' });
	assert.equal(link.host, '203.0.113.2');
	assert.equal(link.port, 2222);
	assert.equal(link.username, 'blog');
	assert.equal(link.webRoot, '/sites/blog.example/files/public');
	assert.deepEqual(link.altDomains, ['www.blog.example']);
});

test('disabled, unknown and malformed site ids are not linked', async () => {
	reset();
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '103' }), /can't be linked \(disabled\)/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '105' }), /can't be linked \(not WordPress\)/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '999' }), /could not be found/);
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'x', id: '../101' }), /Choose a SpinupWP site/);
	assert.ok(!names().includes('discover'));
});

test('uses the typed site user password when the server refuses Local\'s key, and stores it encrypted', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a4', id: String(SHOP), password: 'typed-ssh-pw' });
	assert.deepEqual(discovers().map((d) => d[3]), [null, 'typed-ssh-pw']);
	assert.equal(state.link.authType, 'password');
	assert.equal(state.link.hasPassword, true);
	assert.ok(!settingsFile().includes('typed-ssh-pw'));

	// Later connections reuse the stored password and the stored hints.
	calls.length = 0;
	await handlers[IPC.TEST_CONNECTION]('a4');
	const [d] = discovers();
	assert.equal(d[3], 'typed-ssh-pw');
	assert.deepEqual(d[4], { remotePath: '/sites/shop.example/files', webRoot: '/sites/shop.example/files', excludeDirs: [] });
	assert.ok(!apiCalls().length, 'testing a link needs no API calls');
});

test('explains where to add and attach Local\'s key when it is refused and no password was typed', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP) }),
		/refused Local's SSH key for the site user shop\. Add Local's public key .* in SpinupWP → Account Settings → SSH Keys, attach it to the site's site user in SpinupWP \(shop\) with Add SSH Key, then link again\. Or, if the site user uses password authentication/,
	);
	assert.equal(discovers().length, 1);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('on Windows a refused key is not followed by advice to type a password it has no field for', async () => {
	reset();
	acceptLogin = () => false;
	const platform = Object.getOwnPropertyDescriptor(process, 'platform');
	Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
	try {
		assert.equal((await handlers[IPC.GET_STATE]()).passwordAuthSupported, false);
		const err = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP) }).then(() => null, (e) => e);
		assert.match(err.message, /password authentication is not supported on Windows yet\. Add Local's public key/);
		assert.doesNotMatch(err.message, /type its password/);
	} finally {
		Object.defineProperty(process, 'platform', platform);
	}
	assert.equal(discovers().length, 1);
});

test('explains what to check when both the key and the typed password are refused', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP), password: 'wrong' }),
		/refused both Local's SSH key and the password for the site user shop\. Password logins only work when .* password authentication/,
	);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('an unreachable server is reported as is, and not retried with the password', async () => {
	reset();
	acceptLogin = (t) => new TransportError(`Could not reach ${t.username}@${t.host}:${t.port}: Connection timed out.`, 255, 'ssh: connect to host 203.0.113.1 port 22: Connection timed out');
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', id: String(SHOP), password: 'pw' }), /Connection timed out/);
	assert.equal(discovers().length, 1);
});

test('links with SSH details typed in, finding the folder from the domain', async () => {
	reset();
	const state = await handlers[IPC.LINK_MANUAL]({ siteId: 'm1', host: '198.51.100.7', port: '', username: 'manual', authType: 'key', domain: 'https://Manual.example/' });
	const { link } = state;
	assert.equal(link.mode, 'manual');
	assert.equal(link.host, '198.51.100.7');
	assert.equal(link.port, 22);
	assert.equal(link.domain, 'manual.example');
	assert.deepEqual(link.altDomains, ['www.manual.example']);
	const [d] = discovers();
	assert.deepEqual(d[4], { remotePath: null, webRoot: '/sites/manual.example/files', excludeDirs: [] });
	assert.ok(!apiCalls().length, 'a manual link needs no API');

	calls.length = 0;
	await handlers[IPC.LINK_MANUAL]({ siteId: 'm3', host: '198.51.100.7', port: '22', username: 'manual', authType: 'key' });
	assert.equal(discovers()[0][4].webRoot, null, 'without a domain the usual folders are searched');

	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: '198.51.100.7', username: '-oProxyCommand=x', authType: 'key' }), /Enter the site user/);
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: '-bad', username: 'abc', authType: 'key' }), /Enter the server's IP address/);
	await assert.rejects(handlers[IPC.LINK_MANUAL]({ siteId: 'm2', host: '', username: 'abc', authType: 'key' }), /Enter the server's IP address/);
});

test('toSiteChoices and altDomainsFor handle missing servers and plain-string domains', () => {
	const { toSiteChoices, altDomainsFor } = addonMain;
	const [orphan] = toSiteChoices([site(1, { server_id: 99 })], SERVERS);
	assert.equal(orphan.linkable, false);
	assert.equal(orphan.reason, 'server unknown');
	assert.equal(orphan.group, 'Server 99');
	const [noUser] = toSiteChoices([site(2, { site_user: '-bad' })], SERVERS);
	assert.equal(noUser.reason, 'no site user');
	const [http] = toSiteChoices([site(3, { https: { enabled: false } })], SERVERS);
	assert.equal(http.url, 'http://site3.example/');
	assert.deepEqual(altDomainsFor('a.example', ['b.example', { domain: 'A.example' }, null]), ['b.example', 'www.a.example']);
	assert.deepEqual(altDomainsFor('a.example', [], 'https://x1.qal.spinupwp.site/'), ['x1.qal.spinupwp.site', 'www.a.example']);
	assert.deepEqual(altDomainsFor('a.example', [], 'not a url!'), ['www.a.example']);
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	reset();
	acceptLogin = (t) => Boolean(t.password);
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'account', id: String(SHOP), password: 'typed-ssh-pw', progressId: 'p9' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.ok(names().includes('discover') && names().indexOf('discover') < names().indexOf('addSite'), 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));
	assert.ok(calls.some((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS && c[2] === 'p9'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.label, 'shop.example');
	assert.equal(state.link.authType, 'password');
});

test('pull to new site creates nothing when the connection fails', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: '203.0.113.1', port: '22', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
});

test('disconnecting forgets the token; listing then asks to connect again', async () => {
	reset();
	await handlers[IPC.DISCONNECT_ACCOUNT]();
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
	assert.equal(JSON.parse(settingsFile()).account, null);
	await assert.rejects(handlers[IPC.LIST_SITES](), /Connect your SpinupWP account first/);
	// Links keep working without the account: they log in over SSH only.
	await handlers[IPC.TEST_CONNECTION]('a4');
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: TOKEN });
});
