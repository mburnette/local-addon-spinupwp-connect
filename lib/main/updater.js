'use strict';

const fs = require('fs');
const path = require('path');

/** How often a running copy of Local looks for a new release, and how long after startup it first looks. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** How long to wait for Local to finish swapping in a downloaded release. */
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Local's own add-on installer listens on these (undocumented) channels. Its update handler downloads a .tgz,
 * replaces the add-on folder and reports failures in its own error dialog, exactly like a marketplace update.
 */
const LOCAL_UPDATE_CHANNEL = 'addonInstallerService:update';
const LOCAL_RELAUNCH_CHANNEL = 'addonInstallerService:relaunch';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Splits "v1.2.3-beta.1" into numeric parts and a pre-release tag; null if it isn't a version. */
function parseVersion(version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(version || '').trim());
	if (!match) return null;
	return { parts: match.slice(1, 4).map(Number), pre: match[4] || null };
}

/** Semver ordering, enough for release tags: 1 if a > b, -1 if a < b, 0 if equal or either isn't a version. */
function compareVersions(a, b) {
	const va = parseVersion(a);
	const vb = parseVersion(b);
	if (!va || !vb) return 0;
	for (let i = 0; i < 3; i += 1) {
		if (va.parts[i] !== vb.parts[i]) return va.parts[i] > vb.parts[i] ? 1 : -1;
	}
	if (va.pre === vb.pre) return 0;
	if (!va.pre) return 1;
	if (!vb.pre) return -1;
	return va.pre.localeCompare(vb.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

/** "owner/repo" from package.json's repository field (string or { url }), or null. */
function githubRepoFrom(pkg) {
	const repo = pkg && pkg.repository;
	const raw = typeof repo === 'string' ? repo : repo && repo.url;
	if (!raw) return null;
	const match = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw)
		|| /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw);
	return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Looks for newer releases of this add-on on GitHub and installs them through Local's add-on installer.
 * A release counts when its tag is a higher version than package.json and it has the `npm pack` .tgz attached.
 */
class Updater {
	constructor({ pkg, addonDir, addonsDir, ipcMain, app, fetchImpl, logger = console, onChange = () => {} }) {
		this._pkg = pkg;
		this._addonDir = addonDir;
		this._addonsDir = addonsDir;
		this._ipcMain = ipcMain;
		this._app = app;
		this._fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
		this._logger = logger;
		this._onChange = onChange;
		this._repo = githubRepoFrom(pkg);
		this._release = null;
		this._timers = [];
		this._status = { checking: false, installing: false, installed: false, checkedAt: null, error: null };
	}

	/** Where Local keeps this add-on; a symlink or any other folder means a development copy. */
	get installedDir() {
		return path.join(this._addonsDir, this._pkg.name.replace(/[\\/]/g, '-'));
	}

	isDevInstall() {
		try {
			if (fs.lstatSync(this.installedDir).isSymbolicLink()) return true;
			return fs.realpathSync(this.installedDir) !== fs.realpathSync(this._addonDir);
		} catch (e) {
			return true;
		}
	}

	state() {
		const release = this._release;
		return {
			name: this._pkg.productName || this._pkg.name,
			current: this._pkg.version,
			latest: release ? release.version : null,
			releaseUrl: release ? release.url : (this._repo ? `https://github.com/${this._repo}/releases` : null),
			devInstall: this.isDevInstall(),
			...this._status,
		};
	}

	_set(changes) {
		Object.assign(this._status, changes);
		this._onChange();
	}

	/** Checks now. Automatic checks stay quiet on failure; a manual check reports the error. */
	async check({ manual = false } = {}) {
		if (!this._repo) {
			if (manual) this._set({ error: 'This copy of the add-on does not say where its releases are published.' });
			return this.state();
		}
		this._set({ checking: true, error: null });
		try {
			this._release = await this._latestRelease();
			this._set({ checking: false, checkedAt: Date.now() });
		} catch (e) {
			this._logger.warn(`Update check failed: ${e.message}`);
			this._set({ checking: false, error: manual ? e.message : null });
		}
		return this.state();
	}

	/** The newest release that is newer than this copy and has a .tgz attached, or null. */
	async _latestRelease() {
		const res = await this._fetch(`https://api.github.com/repos/${this._repo}/releases/latest`, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': `${this._pkg.name}/${this._pkg.version}`,
			},
		});
		// 404 means no published release yet.
		if (res.status === 404) return null;
		if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting update checks right now. Try again in an hour.');
		if (!res.ok) throw new Error(`GitHub answered ${res.status} when checking for updates.`);
		const json = await res.json();
		const version = String(json.tag_name || '').replace(/^v/, '');
		if (compareVersions(version, this._pkg.version) <= 0) return null;
		const asset = (json.assets || []).find((a) => /\.tgz$/i.test(a.name));
		if (!asset) {
			this._logger.warn(`Release ${json.tag_name} has no .tgz attached; ignoring it.`);
			return null;
		}
		return { version, url: json.html_url, downloadUrl: asset.browser_download_url };
	}

	/** Hands the release to Local's installer, then waits until the new version is on disk. */
	async install() {
		const release = this._release;
		if (!release) throw new Error('There is no update to install.');
		if (this.isDevInstall()) {
			throw new Error(`This copy of ${this._pkg.productName || this._pkg.name} is linked from a development folder. Update that folder instead.`);
		}
		if (!this._ipcMain || this._ipcMain.listenerCount(LOCAL_UPDATE_CHANNEL) === 0) {
			throw new Error(`This version of Local can't install the update automatically. Download it from ${release.url} and use Add-ons → Install from disk.`);
		}
		this._set({ installing: true, error: null });
		try {
			this._ipcMain.emit(LOCAL_UPDATE_CHANNEL, {}, this._pkg.name, { version: release.version, downloadUrl: release.downloadUrl });
			const deadline = Date.now() + INSTALL_TIMEOUT_MS;
			while (this._installedVersion() !== release.version) {
				if (Date.now() > deadline) {
					throw new Error(`The update to ${release.version} didn't finish. If Local showed an error, download it from ${release.url} and use Add-ons → Install from disk.`);
				}
				await sleep(Updater.pollMs);
			}
			this._set({ installing: false, installed: true });
		} catch (e) {
			this._set({ installing: false, error: e.message });
			throw e;
		}
		return this.state();
	}

	_installedVersion() {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.installedDir, 'package.json'), 'utf8')).version;
		} catch (e) {
			return null;
		}
	}

	/** Restarts Local so it loads the new version; Local's own relaunch stops sites cleanly first. */
	restart() {
		if (this._ipcMain && this._ipcMain.listenerCount(LOCAL_RELAUNCH_CHANNEL) > 0) {
			this._ipcMain.emit(LOCAL_RELAUNCH_CHANNEL, {});
		} else if (this._app) {
			this._app.relaunch();
			this._app.quit();
		}
	}

	start() {
		const first = setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS);
		const repeat = setInterval(() => this.check(), CHECK_INTERVAL_MS);
		[first, repeat].forEach((t) => t.unref && t.unref());
		this._timers.push(first, repeat);
	}

	stop() {
		this._timers.forEach((t) => clearTimeout(t));
		this._timers = [];
	}
}

Updater.pollMs = 1000;

module.exports = { Updater, compareVersions, githubRepoFrom, LOCAL_UPDATE_CHANNEL, LOCAL_RELAUNCH_CHANNEL };
