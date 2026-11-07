'use strict';

/**
 * Mounts the renderer half in jsdom with the real @getflywheel/local-components and React 16 (the version Local
 * ships), stubbing only Electron and Local's renderer API. Catches bad imports/props before Local ever loads it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="popup-container"></div></body></html>', {
	pretendToBeVisual: true,
});
// React's scheduler keeps a MessageChannel port open, and jsdom an animation-frame timer (pretendToBeVisual); both
// would keep the test process alive after the last test, so they are closed once the tests are done.
const channels = [];
global.MessageChannel = class TrackedMessageChannel extends MessageChannel {
	constructor() {
		super();
		channels.push(this);
	}
};
test.after(() => {
	channels.forEach((channel) => {
		channel.port1.close();
		channel.port2.close();
	});
	dom.window.close();
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// Remaining DOM constructors (HTMLCollection, NodeList, …) that react-modal and friends expect as globals.
Object.getOwnPropertyNames(dom.window)
	.filter((key) => /^[A-Z]/.test(key) && !(key in global))
	.forEach((key) => { global[key] = dom.window[key]; });

const { IPC } = require('../lib/constants');

let mainState;
let linkedSites = {};
let compareResult;
let siteChoices;
let listError = null;
let testRemote = null;
const ipcCalls = [];
const listeners = {};

/** Site choices as main's toSiteChoices builds them: grouped by server, then by domain. */
const choice = (id, domain, siteUser, extra = {}) => ({
	id, displayName: domain, domain, url: `https://${domain}/`, siteUser, serverId: '1', serverName: 'web-1',
	state: 'deployed', linkable: true, reason: null, group: 'web-1', ...extra,
});
const SHOP = choice('101', 'shop.example.com', 'shop');
const DEFAULT_CHOICES = [
	choice('103', 'broken.example.com', 'broken', { state: 'disabled', linkable: false, reason: 'disabled' }),
	SHOP,
	choice('105', 'static.example.com', 'static', { linkable: false, reason: 'not WordPress' }),
	choice('102', 'blog.example.com', 'blog', { serverId: '2', serverName: 'web-2', group: 'web-2' }),
];

const stubs = {
	electron: {
		ipcRenderer: {
			on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
			removeListener: (ch, fn) => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); },
		},
		shell: { openExternal() {} },
	},
	'@getflywheel/local/renderer': {
		ipcAsync: async (channel, ...args) => {
			ipcCalls.push([channel, ...args]);
			if (channel === IPC.GET_STATE) return mainState;
			if (channel === IPC.LINKED_SITES) return linkedSites;
			if (channel === IPC.LIST_SITES) {
				if (listError) throw listError;
				return siteChoices || DEFAULT_CHOICES;
			}
			if (channel === IPC.TEST_CONNECTION) return testRemote;
			if (channel === IPC.GET_PUBLIC_KEY) return 'ssh-rsa AAAAB3Nza test';
			if (channel === IPC.COMPARE) return compareResult;
			if (channel === IPC.NEW_SITE_LOCATION) return { domain: `${args[0].toLowerCase()}.local`, sitePath: `~/Local Sites/${args[0].toLowerCase()}` };
			if (channel === IPC.PULL_NEW_SITE) return { domain: 'shop.local', sitePath: '~/Local Sites/shop' };
			return null;
		},
		confirm: async () => true,
	},
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
	return originalLoad.call(this, request, ...rest);
};

const React = require('react');
const ReactDOM = require('react-dom');
const { act } = require('react-dom/test-utils');

const registered = { content: {}, filters: {} };
const hooks = {
	addContent: (name, cb) => { (registered.content[name] = registered.content[name] || []).push(cb); },
	addFilter: (name, cb) => { (registered.filters[name] = registered.filters[name] || []).push(cb); },
};
require('../lib/renderer')({ React, ReactRouter: require('react-router-dom'), hooks });

const site = { id: 'site1', name: 'Shop Local', domain: 'shop.local' };

async function mount(element) {
	const root = document.getElementById('root');
	await act(async () => {
		ReactDOM.render(element, root);
	});
	// let ipcAsync promises and effects settle
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	return root;
}

async function click(el) {
	await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text && b.getAttribute('role') !== 'tab');
const tab = (root, text) => [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === text);

function toolsPanel() {
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	assert.equal(items.length, 1);
	return items[0].render();
}

/** Broadcasts a state change, as main does after linking/unlinking, and lets the marks catch up. */
async function stateChanged(newLinked) {
	linkedSites = newLinked;
	await act(async () => {
		(listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null));
		await new Promise((r) => setTimeout(r, 20));
	});
}

test.after(() => dom.window.close());

test.afterEach(async () => {
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });
	document.getElementById('popup-container').innerHTML = '';
	siteChoices = null;
});

test('registers stylesheet, tools tab, header, create-site option and route hooks', () => {
	assert.equal(registered.content.stylesheets.length, 1);
	const options = registered.filters['CreateSite:RadioOptions'][0]({ 'add-site': { label: 'Create a new site' } });
	assert.deepEqual(Object.keys(options), ['add-site', 'spinupwp-pull']);
	assert.equal(options['spinupwp-pull'].label, 'Pull from SpinupWP');
	const route = registered.content['routes[main]'][0]({});
	assert.equal(route.props.path, '/main/spinupwp-pull');
	assert.equal(registered.filters.siteInfoToolsItem.length, 1);
	assert.equal(registered.content.SiteInfo_Top_TopRight.length, 1);
	const link = registered.content.stylesheets[0]();
	assert.match(link.props.href, /lib\/renderer\/styles\.css$/);
});

const typeInto = async (input, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const fieldInput = (root, label) => [...root.querySelectorAll('.SPConnect_Field')]
	.find((f) => f.querySelector('.SPConnect_FieldLabel').textContent === label)
	.querySelector('input');

const fieldNamed = (root, label) => [...root.querySelectorAll('.SPConnect_Field')]
	.find((f) => f.querySelector('.SPConnect_FieldLabel').textContent === label);
const selectValue = async (select, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
	select.dispatchEvent(new window.Event('change', { bubbles: true }));
});
const LINKED_SHOP = {
	mode: 'account', platform: 'spinupwp', authType: 'password', label: 'Shop', domain: 'shop.example.com', directory: '',
	spinupwpSiteId: '101', spinupwpServerId: '1', serverName: 'web-1', host: '203.0.113.10', port: 22, username: 'shop',
	remotePath: '/sites/shop.example.com/files', nested: [], excludeDirs: [], altDomains: [], managed: [],
};
const ACCOUNT = { connectedAt: '2026-11-05T00:00:00Z', sites: 4, servers: 2 };

test('asks for a SpinupWP API token when no account is connected', async () => {
	mainState = { account: null, link: null, publicKey: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.ok(tab(root, 'SpinupWP API'));
	assert.ok(tab(root, 'SSH details'));
	assert.match(root.textContent, /In SpinupWP, open My Account → API Tokens \(or Team Settings → API Tokens for a team token\), create a token and copy it/);
	assert.doesNotMatch(root.textContent, /hPanel|Client ID|Client Secret|API Applications/);
	assert.equal(fieldInput(root, 'API token').type, 'password', 'the token is masked');
	assert.equal(button(root, 'Connect').getAttribute('aria-disabled'), 'true', 'the token is needed');

	await typeInto(fieldInput(root, 'API token'), 'spinupwp-token');
	ipcCalls.length = 0;
	await click(button(root, 'Connect'));
	assert.deepEqual(ipcCalls.find(([ch]) => ch === IPC.CONNECT_ACCOUNT)[1], { apiKey: 'spinupwp-token' });
});

test('lists sites by server, disables unlinkable ones and links the chosen one', async () => {
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /Connected to SpinupWP · 4 sites on 2 servers/);
	assert.deepEqual([...root.querySelectorAll('select optgroup')].map((g) => g.label), ['web-1', 'web-2']);
	const options = [...root.querySelectorAll('select option')];
	assert.deepEqual(options.map((o) => o.textContent), [
		'broken.example.com (disabled)',
		'shop.example.com (site user shop)',
		'static.example.com (not WordPress)',
		'blog.example.com (site user blog)',
	]);
	assert.deepEqual(options.map((o) => o.disabled), [true, false, true, false], 'unlinkable sites cannot be picked');
	assert.equal(root.querySelector('select').value, SHOP.id, 'the first linkable site is preselected');
	assert.equal(root.querySelector('textarea').value, 'ssh-rsa AAAAB3Nza test', 'shows Local\'s key to add in SpinupWP');
	assert.match(fieldNamed(root, 'Local\'s SSH key').textContent, /SpinupWP → Account Settings → SSH Keys, then attach it to the site's site user \(Add SSH Key\)/);
	assert.match(fieldNamed(root, 'Site user password (optional)').textContent, /site user uses password authentication/);
	assert.equal(fieldInput(root, 'Site user password (optional)').type, 'password');

	// Without a typed password only the choice's id goes to main, which reads the site again itself.
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(sent, { siteId: 'site1', id: SHOP.id });
	assert.match(progressId, /^link-/);

	// A site on another server, with a typed site user password.
	await selectValue(root.querySelector('select'), '102');
	await typeInto(fieldInput(root, 'Site user password (optional)'), 'ssh-pw');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId: _id, ...second } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(second, { siteId: 'site1', id: '102', password: 'ssh-pw' });
});

test('explains why a site cannot be linked and hides the password field where it is unsupported', async () => {
	siteChoices = [DEFAULT_CHOICES[0]];
	mainState = { account: { ...ACCOUNT, sites: 1, servers: 1 }, link: null, passwordAuthSupported: false };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /SpinupWP · 1 site on 1 server(?!s)/);
	assert.match(root.textContent, /This site can't be linked: disabled\./);
	assert.equal(button(root, 'Link Shop Local').getAttribute('aria-disabled'), 'true');
	assert.equal(fieldNamed(root, 'Site user password (optional)'), undefined, 'Windows logs in with the key only');
});

test('says so when the token sees no sites', async () => {
	siteChoices = [];
	mainState = { account: { ...ACCOUNT, sites: 0 }, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /No sites were found for this API token\. A team token only sees that team's sites/);
	assert.equal(root.querySelector('select'), null);
});

test('a failed site listing shows the error and can be retried, without a spinner that never stops', async () => {
	listError = new Error('SpinupWP doesn\'t accept this API token.');
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	try {
		const root = await mount(toolsPanel());
		assert.match(root.querySelector('[role="alert"]').textContent, /doesn't accept this API token/);
		assert.doesNotMatch(root.textContent, /Loading your SpinupWP sites/);
		listError = null;
		await click(button(root, 'Refresh list'));
		assert.equal(root.querySelectorAll('select option').length, DEFAULT_CHOICES.length);
		assert.equal(root.querySelector('[role="alert"]'), null);
	} finally {
		listError = null;
	}
});

test('SSH details tab logs in as the site user on the server\'s IP address, port 22 by default', async () => {
	mainState = { account: null, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	await click(tab(root, 'SSH details'));
	assert.match(root.textContent, /the server's IP address is on its server page in SpinupWP, and the site user on the site's page/);
	assert.equal(fieldInput(root, 'Server IP address').value, '', 'no default host: every server has its own');
	assert.equal(fieldInput(root, 'Port').value, '22');
	assert.equal(fieldInput(root, 'Remote path (optional)').placeholder, '/sites/example.com/files');
	assert.ok(fieldNamed(root, 'Public key'), 'Local\'s key is the default');
	assert.match(fieldNamed(root, 'Public key').textContent, /attach it to the site's site user/);
	assert.equal(button(root, 'Link Shop Local').getAttribute('aria-disabled'), 'true', 'the IP address and site user are needed');
	await typeInto(fieldInput(root, 'Server IP address'), '203.0.113.10');
	await typeInto(fieldInput(root, 'Site user'), 'shop');
	await click(root.querySelectorAll('.SPConnect_AuthChoice input')[0]);
	await typeInto(fieldInput(root, 'Password'), 'pw');
	await typeInto(fieldInput(root, 'Site domain (optional)'), 'example.com');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_MANUAL)[1];
	assert.deepEqual(sent, {
		siteId: 'site1', host: '203.0.113.10', port: '22', username: 'shop', authType: 'password', password: 'pw', remotePath: '', domain: 'example.com',
	});
});

test('linked site shows the site, its server, SSH login and webroot, and pushes with the chosen options', async () => {
	mainState = { account: null, passwordAuthSupported: true, link: LINKED_SHOP };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /SiteShop/);
	assert.match(root.textContent, /Domainshop\.example\.com/);
	assert.match(root.textContent, /Serverweb-1 \(203\.0\.113\.10\)/);
	assert.match(root.textContent, /SSH loginshop@203\.0\.113\.10(?!:)/, 'port 22 is not spelled out');
	assert.match(root.textContent, /Remote path\/sites\/shop\.example\.com\/files/);
	assert.doesNotMatch(root.textContent, /Never synced/);
	assert.match(root.textContent, /Site user's password \(stored encrypted\)\. Add Local's SSH key in SpinupWP → Account Settings → SSH Keys, attach it to the site's site user/);
	assert.match(root.textContent, /Files \(everything in app\/public except wp-config\.php\)/);
	assert.match(root.textContent, /Clear SpinupWP caches afterwards \(page cache and object cache\)/);
	assert.doesNotMatch(root.textContent, /hPanel|LiteSpeed|Edge Cache|Jetpack/);

	const pushButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Push to SpinupWP' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pushButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.ok(push, 'push IPC should be sent');
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { files: true, database: true, deleteRemote: true, purgeCache: true },
	});
});

test('a manual link has no Server row, clears caches through the plugin, and Test connection is accurate about WP-CLI', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /AuthenticationLocal's SSH key/);
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });

	mainState = { account: null, link: { mode: 'manual', platform: null, authType: 'key', host: '203.0.113.10', port: 2222, username: 'abc', remotePath: '/sites/example.com/files', domain: 'example.com', label: 'example.com' } };
	root = await mount(toolsPanel());
	assert.match(root.textContent, /Siteexample\.comSSH loginabc@203\.0\.113\.10:2222/);
	assert.doesNotMatch(root.textContent, /Server203/, 'the SSH login already shows the address');
	assert.doesNotMatch(root.textContent, /Domain/, 'the domain is already the label');
	assert.match(root.textContent, /Clear caches afterwards \(WordPress's object cache, and the page cache through the SpinupWP plugin\)/);

	testRemote = { remotePath: '/sites/example.com/files', hasWpCli: false, hasPhp: true };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /WP-CLI missing: the first database push or pull installs it/);
	testRemote = { remotePath: '/sites/example.com/files', hasWpCli: true, hasPhp: true };
	await click(button(root, 'Test connection'));
	assert.match(root.textContent, /Connected\. WordPress found at \/sites\/example\.com\/files\./);
	testRemote = null;
});

test('pull tab sends a pull with its own options', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key' } };
	const root = await mount(toolsPanel());
	const pullTab = [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'Pull from SpinupWP');
	await act(async () => { pullTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(root.textContent, /Files \(everything in the webroot except wp-config\.php, server config and caches\)/);
	assert.match(root.textContent, /Back up the Local database first/);
	assert.match(root.textContent, /Delete Local files that are not on SpinupWP/);
	assert.doesNotMatch(root.textContent, /Clear SpinupWP caches|SpinupWP backup/);

	const pullButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pull from SpinupWP' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pullButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const pull = ipcCalls.find(([ch]) => ch === IPC.PULL);
	assert.ok(pull, 'pull IPC should be sent');
	assert.deepEqual(pull[1], { siteId: 'site1', options: { files: true, database: true, backupLocal: true, deleteLocal: true } });
});

test('header buttons only appear for linked sites and open push/pull modals', async () => {
	mainState = { account: null, link: null };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	assert.equal(root.textContent, '');

	// Linking elsewhere (e.g. in the Tools tab) broadcasts a state change; the header picks it up.
	mainState = { account: null, link: { mode: 'manual', authType: 'password', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	await act(async () => {
		listeners[IPC.STATE_CHANGED].forEach((fn) => fn({}, 'site1'));
		await new Promise((r) => setTimeout(r, 10));
	});
	const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
	assert.deepEqual(labels, ['Pull', 'Push']);

	await act(async () => { root.querySelectorAll('button')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(document.body.textContent, /This overwrites the files and database of Shop Local in Local with shop\.example\.com/);
});

test('push modal spells out what changes on SpinupWP, what never does, and how to roll back', async () => {
	mainState = { account: null, link: LINKED_SHOP };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	await act(async () => { root.querySelectorAll('button')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	const text = document.body.textContent;
	assert.match(text, /This overwrites the files and database on Shop with Shop Local from Local\. Visitors see the change right away\./);
	assert.match(text, /private \.spinupwp-connect folder in the site user's home folder, outside the website/);
	assert.match(text, /Files on SpinupWP that do not exist locally will be deleted\. wp-config\.php, the caching drop-ins and must-use plugins that only exist on the server are never touched/);
	assert.match(text, /This push does not make a SpinupWP backup\. If the site has backups turned on in SpinupWP, you can restore one from the site's Backups page/);
	assert.doesNotMatch(text, /hPanel/);
});

test('header shows progress and disables both buttons while a pull runs', async () => {
	mainState = { account: null, activity: 'pull', link: { mode: 'manual', authType: 'key', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'pulling'));
	const buttons = [...root.querySelectorAll('button')];
	assert.deepEqual(buttons.map((b) => b.textContent), ['Pulling…', 'Push']);
	// Local's buttons mark disabled state with aria-disabled and swallow clicks.
	assert.ok(buttons.every((b) => b.getAttribute('aria-disabled') === 'true'));
	await act(async () => { buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.doesNotMatch(document.body.textContent, /This overwrites/, 'no modal while a transfer is running');
});

test('compare view groups differences and syncs only the selected files', async () => {
	mainState = { account: null, link: { ...LINKED_SHOP, authType: 'key' } };
	compareResult = {
		at: '2026-10-30T00:00:00Z',
		checksum: false,
		entries: [
			{ path: 'wp-content/themes/shop/style.css', type: 'file', status: 'changed', local: { size: 2048, mtime: 1790000000 }, remote: { size: 1900, mtime: 1780000000 }, newer: 'local' },
			{ path: 'wp-content/plugins/new/new.php', type: 'file', status: 'local-only', local: { size: 10, mtime: 1790000000 }, remote: null, newer: null },
			{ path: 'wp-content/uploads/2026/10/photo.jpg', type: 'file', status: 'remote-only', local: null, remote: { size: 3 * 1024 * 1024, mtime: 1790000000 }, newer: null },
		],
	};
	const root = await mount(toolsPanel());
	await click(tab(root, 'Compare & sync files'));
	ipcCalls.length = 0;
	await click(button(root, 'Compare with SpinupWP'));
	assert.deepEqual(ipcCalls[0], [IPC.COMPARE, { siteId: 'site1', checksum: false }]);
	assert.match(root.textContent, /1 different on each side · 1 only in local · 1 only on spinupwp/);
	assert.match(root.textContent, /Newer in Local/);
	assert.match(root.textContent, /3\.0 MB/);

	// Filter narrows the list
	const filter = root.querySelector('.SPConnect_Filter input');
	await typeInto(filter, 'themes');
	assert.equal(root.querySelectorAll('.SPConnect_FileRow').length, 1);
	await typeInto(filter, '');

	// Select the changed theme file and the remote-only upload, then push them
	const rows = [...root.querySelectorAll('.SPConnect_FileRow input')];
	await click(rows[0]);
	await click(rows[2]);
	assert.match(root.textContent, /2 selected/);
	ipcCalls.length = 0;
	await click(button(root, 'Push selected'));
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { fileList: ['wp-content/themes/shop/style.css', 'wp-content/uploads/2026/10/photo.jpg'], purgeCache: true },
	});
	assert.ok(ipcCalls.some(([ch]) => ch === IPC.COMPARE), 'compares again after syncing');
});

test('create-site page pulls a SpinupWP site into a new Local site', async () => {
	mainState = { account: ACCOUNT, link: null, passwordAuthSupported: true };
	const history = { pushed: [], push(p) { this.pushed.push(p); } };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history }));
	await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

	assert.match(root.textContent, /Pull from SpinupWP/);
	assert.match(root.textContent, /pulls the files and database of a SpinupWP site/);
	const nameInput = root.querySelector('input');
	assert.equal(nameInput.value, 'shop.example.com', 'defaults to the selected site\'s domain');
	assert.match(root.textContent, /shop\.example\.com\.local · ~\/Local Sites\/shop\.example\.com/, 'the stand-in main names the folder after the input');

	ipcCalls.length = 0;
	await click(button(root, 'Create site & pull'));
	const { siteName, source } = ipcCalls.find(([ch]) => ch === IPC.PULL_NEW_SITE)[1];
	const { progressId, ...rest } = source;
	assert.equal(siteName, 'shop.example.com');
	assert.deepEqual(rest, { kind: 'account', id: SHOP.id });
	assert.match(progressId, /^link-/, 'lets the main process stream progress back to this form');
	assert.match(root.textContent, /Creating shop\.example\.com at shop\.local/);

	await click(button(root, '← Back'));
	assert.deepEqual(history.pushed, ['/main/create-site']);
});

test('create-site page names the Local site after the domain when the site has no display name', async () => {
	siteChoices = [{ ...SHOP, displayName: '' }];
	mainState = { account: { ...ACCOUNT, sites: 1 }, link: null, passwordAuthSupported: true };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history: { push() {} } }));
	assert.equal(root.querySelector('input').value, 'shop.example.com');
	assert.equal(root.querySelector('select option').textContent, 'shop.example.com (site user shop)');
});

test('brand: SpinupWP blue icon tile, add-on card colour and stylesheet accent', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const rootDir = path.join(__dirname, '..');
	const icon = fs.readFileSync(path.join(rootDir, 'icon.svg'), 'utf8');
	assert.match(icon, /<rect width="120" height="120" rx="24" fill="#87a8ed"\/>/, 'the SpinupWP blue tile');
	assert.match(icon, /<g [^>]*fill="#fff">\s*<path [^>]*d="M115\.855 24\.5938/, 'SpinupWP\'s swoosh, from the official logo, in white');
	assert.doesNotMatch(icon, /#dd3a03/);
	assert.equal(require('../package.json').bgColor, '#87a8ed');
	const css = fs.readFileSync(path.join(rootDir, 'lib', 'renderer', 'styles.css'), 'utf8');
	assert.match(css, /--sp-accent: #87a8ed;/);
	assert.doesNotMatch(css, /#dd3a03|#e5541f|#673de6|#ff492c|103, 61, 230|purple|orange/i, 'no leftover accent from the previous brand');
});

test('shows an available update and installs it through the main process', async () => {
	const update = { name: 'ConnectLocal for SpinupWP', current: '0.1.0', latest: '0.2.0', releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0', devInstall: false, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update };
	ipcCalls.length = 0;
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for SpinupWP 0\.2\.0 is available\. You have 0\.1\.0\./);
	await click(button(root, 'Update'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.INSTALL_UPDATE));

	mainState = { ...mainState, update: { ...update, installed: true } };
	await act(async () => { (listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	assert.match(root.textContent, /0\.2\.0 is installed\. Restart Local/);
	await click(button(root, 'Restart Local'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.RESTART_LOCAL));
});

test('a development copy shows the update but no Update button, and the footer can check manually', async () => {
	const update = { name: 'ConnectLocal for SpinupWP', current: '0.1.0', latest: null, releaseUrl: null, devInstall: true, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update: { ...update, latest: '0.2.0' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /linked from a development folder/);
	assert.equal(button(root, 'Update'), undefined);
	await act(async () => { ReactDOM.unmountComponentAtNode(root); });

	mainState = { ...mainState, update };
	ipcCalls.length = 0;
	root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for SpinupWP 0\.1\.0/);
	await click(button(root, 'Check for updates'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.CHECK_UPDATE));
	assert.match(root.textContent, /You have the latest version\./);
});

test('tools tab entry shows a check only while the site is linked', async () => {
	await stateChanged({});
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	const root = await mount(items[0].menuItem);
	assert.equal(root.textContent, 'SpinupWP');
	assert.ok(!root.querySelector('.SPConnect_LinkedCheck'));
	await stateChanged({ site1: 'shop.example.com' });
	assert.ok(root.querySelector('.SPConnect_LinkedCheck'), 'check appears once linked');
	await stateChanged({});
	assert.ok(!root.querySelector('.SPConnect_LinkedCheck'), 'check goes away on unlink');
});

test('sites list gets a logo mark that shares one strip with other ConnectLocal add-ons', async () => {
	const sidebar = document.createElement('nav');
	sidebar.innerHTML = ['site1', 'site2'].map((id) => `<a class="TID_SiteListSite" data-site-id="${id}">`
		+ `<span class="icon"></span><span class="TID_SiteListSite_Span_SiteName">${id}</span><time>Oct 27</time></a>`).join('');
	document.body.appendChild(sidebar);
	const row = (id) => sidebar.querySelector(`[data-site-id="${id}"]`);
	const hosts = (id) => [...row(id).querySelectorAll('[data-connectlocal-host]')].map((m) => m.getAttribute('data-connectlocal-host'));
	try {
		// Another add-on (Kinsta) already marked site1; ours must join its strip in alphabetical order (after it).
		const strip = document.createElement('span');
		strip.setAttribute('data-connectlocal-marks', '');
		const kinsta = document.createElement('span');
		kinsta.setAttribute('data-connectlocal-host', 'kinsta');
		strip.appendChild(kinsta);
		row('site1').insertBefore(strip, row('site1').querySelector('time'));

		await stateChanged({ site1: 'shop.example.com', site2: null });
		assert.deepEqual(hosts('site1'), ['kinsta', 'spinupwp']);
		assert.deepEqual(hosts('site2'), ['spinupwp']);
		assert.equal(row('site1').querySelectorAll('[data-connectlocal-marks]').length, 1, 'one strip per row');
		const mark = row('site1').querySelector('[data-connectlocal-host="spinupwp"]');
		assert.equal(mark.title, 'Linked to SpinupWP (shop.example.com)');
		assert.match(mark.style.backgroundImage, /data:image\/svg\+xml/);
		// Strip sits right after the site name, before Local's own extras.
		assert.equal(row('site2').querySelector('.TID_SiteListSite_Span_SiteName').nextSibling.hasAttribute('data-connectlocal-marks'), true);

		// Rows Local renders later are picked up by the observer.
		sidebar.insertAdjacentHTML('beforeend', '<a class="TID_SiteListSite" data-site-id="site3"><span class="TID_SiteListSite_Span_SiteName">site3</span></a>');
		await stateChanged({ site1: 'shop.example.com', site2: null, site3: null });
		assert.deepEqual(hosts('site3'), ['spinupwp']);

		// Unlinking removes only our mark; an emptied strip goes too.
		await stateChanged({});
		assert.deepEqual(hosts('site1'), ['kinsta']);
		assert.equal(row('site2').querySelector('[data-connectlocal-marks]'), null);
	} finally {
		sidebar.remove();
	}
});
