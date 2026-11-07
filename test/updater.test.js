'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Updater, compareVersions, githubRepoFrom, LOCAL_UPDATE_CHANNEL, LOCAL_RELAUNCH_CHANNEL } = require('../lib/main/updater');

Updater.pollMs = 5;

const PKG = {
	name: 'local-addon-example',
	productName: 'Example',
	version: '0.1.0',
	repository: { type: 'git', url: 'git+https://github.com/someone/example-addon.git' },
};

/** A Local addons folder holding a real (not symlinked) copy of the add-on. */
function makeInstall(version = PKG.version) {
	const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-updater-'));
	const addonDir = path.join(addonsDir, PKG.name);
	fs.mkdirSync(addonDir);
	fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({ ...PKG, version }));
	return { addonsDir, addonDir };
}

const releaseFetch = (release, status = 200) => async (url) => {
	assert.strictEqual(url, 'https://api.github.com/repos/someone/example-addon/releases/latest');
	return { status, ok: status === 200, json: async () => release };
};

const RELEASE = {
	tag_name: 'v0.2.0',
	html_url: 'https://github.com/someone/example-addon/releases/tag/v0.2.0',
	assets: [{ name: 'local-addon-example-0.2.0.tgz', browser_download_url: 'https://github.com/someone/example-addon/releases/download/v0.2.0/local-addon-example-0.2.0.tgz' }],
};

const quietLogger = { warn() {}, info() {} };

test('compareVersions orders release tags', () => {
	assert.strictEqual(compareVersions('0.2.0', '0.1.9'), 1);
	assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0);
	assert.strictEqual(compareVersions('1.0.0', '1.0.10'), -1);
	assert.strictEqual(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
	assert.strictEqual(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
	assert.strictEqual(compareVersions('not-a-version', '1.0.0'), 0);
});

test('githubRepoFrom reads the common repository formats', () => {
	assert.strictEqual(githubRepoFrom({ repository: 'github:a/b' }), 'a/b');
	assert.strictEqual(githubRepoFrom({ repository: 'a/b' }), 'a/b');
	assert.strictEqual(githubRepoFrom({ repository: { url: 'git+https://github.com/a/b.git' } }), 'a/b');
	assert.strictEqual(githubRepoFrom({ repository: { url: 'git@github.com:a/b-c.git' } }), 'a/b-c');
	assert.strictEqual(githubRepoFrom({}), null);
});

test('check finds a newer release with a .tgz', async () => {
	const { addonsDir, addonDir } = makeInstall();
	const updater = new Updater({ pkg: PKG, addonDir, addonsDir, fetchImpl: releaseFetch(RELEASE), logger: quietLogger });
	const state = await updater.check();
	assert.strictEqual(state.latest, '0.2.0');
	assert.strictEqual(state.releaseUrl, RELEASE.html_url);
	assert.strictEqual(state.devInstall, false);
	assert.strictEqual(state.name, 'Example');
});

test('check ignores same or older versions, releases without a .tgz, and a repo with no releases', async () => {
	const { addonsDir, addonDir } = makeInstall();
	const cases = [
		releaseFetch({ ...RELEASE, tag_name: 'v0.1.0' }),
		releaseFetch({ ...RELEASE, assets: [{ name: 'source.zip', browser_download_url: 'x' }] }),
		releaseFetch({ message: 'Not Found' }, 404),
	];
	for (const fetchImpl of cases) {
		const state = await new Updater({ pkg: PKG, addonDir, addonsDir, fetchImpl, logger: quietLogger }).check({ manual: true });
		assert.strictEqual(state.latest, null);
		assert.strictEqual(state.error, null);
	}
});

test('automatic checks stay quiet on failure; manual checks report it', async () => {
	const { addonsDir, addonDir } = makeInstall();
	const fetchImpl = async () => { throw new Error('offline'); };
	const updater = new Updater({ pkg: PKG, addonDir, addonsDir, fetchImpl, logger: quietLogger });
	assert.strictEqual((await updater.check()).error, null);
	assert.strictEqual((await updater.check({ manual: true })).error, 'offline');
});

test('install hands the release to Local and waits for the new version on disk', async () => {
	const { addonsDir, addonDir } = makeInstall();
	const ipcMain = new EventEmitter();
	let request;
	ipcMain.on(LOCAL_UPDATE_CHANNEL, (_event, name, release) => {
		request = { name, release };
		setTimeout(() => fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({ ...PKG, version: '0.2.0' })), 20);
	});
	const updater = new Updater({ pkg: PKG, addonDir, addonsDir, ipcMain, fetchImpl: releaseFetch(RELEASE), logger: quietLogger });
	await updater.check();
	const state = await updater.install();
	assert.deepStrictEqual(request, { name: PKG.name, release: { version: '0.2.0', downloadUrl: RELEASE.assets[0].browser_download_url } });
	assert.strictEqual(state.installed, true);
	assert.strictEqual(state.installing, false);
});

test('install refuses a symlinked development copy', async () => {
	const { addonsDir } = makeInstall();
	const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-updater-dev-'));
	fs.writeFileSync(path.join(devDir, 'package.json'), JSON.stringify(PKG));
	fs.rmSync(path.join(addonsDir, PKG.name), { recursive: true });
	fs.symlinkSync(devDir, path.join(addonsDir, PKG.name));
	const ipcMain = new EventEmitter();
	ipcMain.on(LOCAL_UPDATE_CHANNEL, () => assert.fail('should not install over a development copy'));
	const updater = new Updater({ pkg: PKG, addonDir: devDir, addonsDir, ipcMain, fetchImpl: releaseFetch(RELEASE), logger: quietLogger });
	const state = await updater.check();
	assert.strictEqual(state.devInstall, true);
	await assert.rejects(updater.install(), /development folder/);
});

test('install explains the manual route when Local has no installer channel', async () => {
	const { addonsDir, addonDir } = makeInstall();
	const updater = new Updater({ pkg: PKG, addonDir, addonsDir, ipcMain: new EventEmitter(), fetchImpl: releaseFetch(RELEASE), logger: quietLogger });
	await updater.check();
	await assert.rejects(updater.install(), /Install from disk/);
});

test('restart uses Local\'s relaunch, falling back to Electron', () => {
	const { addonsDir, addonDir } = makeInstall();
	const ipcMain = new EventEmitter();
	let relaunched = 0;
	ipcMain.on(LOCAL_RELAUNCH_CHANNEL, () => { relaunched += 1; });
	new Updater({ pkg: PKG, addonDir, addonsDir, ipcMain }).restart();
	assert.strictEqual(relaunched, 1);

	const calls = [];
	const app = { relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') };
	new Updater({ pkg: PKG, addonDir, addonsDir, ipcMain: new EventEmitter(), app }).restart();
	assert.deepStrictEqual(calls, ['relaunch', 'quit']);
});
