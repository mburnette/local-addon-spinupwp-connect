'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persists the SpinupWP API token and per-site links in <Local userData>/spinupwp-connect/settings.json.
 *
 * Secrets (the API Client Secret and any SSH password) are encrypted with Electron's safeStorage (macOS Keychain / Windows
 * DPAPI / libsecret). Local's own context.storage is not used because its getter does not return the stored value.
 */
class Store {
	constructor(dir, safeStorage) {
		this.dir = dir;
		this.file = path.join(dir, 'settings.json');
		this._safeStorage = safeStorage;
		this._data = this._read();
	}

	_read() {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			return { account: data.account || null, sites: data.sites || {} };
		} catch (e) {
			return { account: null, sites: {} };
		}
	}

	_write() {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this._data, null, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}

	encrypt(value) {
		if (value === undefined || value === null || value === '') return null;
		const ss = this._safeStorage;
		if (ss && ss.isEncryptionAvailable()) {
			return `enc:${ss.encryptString(String(value)).toString('base64')}`;
		}
		return `b64:${Buffer.from(String(value), 'utf8').toString('base64')}`;
	}

	decrypt(stored) {
		if (!stored) return null;
		if (stored.startsWith('enc:')) {
			return this._safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
		}
		if (stored.startsWith('b64:')) {
			return Buffer.from(stored.slice(4), 'base64').toString('utf8');
		}
		return stored;
	}

	/**
	 * The SpinupWP API token used to list and link sites: { apiKey, connectedAt, sites, servers } (counts at connect
	 * time).
	 */
	getAccount() {
		const { account } = this._data;
		if (!account) return null;
		return { ...account, apiKey: this.decrypt(account.apiKey) };
	}

	setAccount({ apiKey, ...rest }) {
		this._data.account = { ...rest, apiKey: this.encrypt(apiKey) };
		this._write();
	}

	/** Account data that is safe to hand to the renderer. */
	getPublicAccount() {
		const { account } = this._data;
		if (!account) return null;
		const { apiKey, ...rest } = account;
		return rest;
	}

	/** Every stored link, for checks that span sites (e.g. whether an SSH key is still in use). */
	allLinks() {
		return Object.values(this._data.sites);
	}

	clearAccount() {
		this._data.account = null;
		this._write();
	}

	getLink(siteId) {
		const link = this._data.sites[siteId];
		if (!link) return null;
		return { ...link, password: this.decrypt(link.password) };
	}

	setLink(siteId, link) {
		const { password, ...rest } = link;
		this._data.sites[siteId] = { ...rest, password: this.encrypt(password), updatedAt: new Date().toISOString() };
		this._write();
	}

	updateLink(siteId, patch) {
		if (!this._data.sites[siteId]) return;
		this._data.sites[siteId] = { ...this._data.sites[siteId], ...patch };
		this._write();
	}

	removeLink(siteId) {
		delete this._data.sites[siteId];
		this._write();
	}

	/** siteId -> remote domain (or null) for every linked site. */
	linkedSites() {
		return Object.fromEntries(Object.entries(this._data.sites).map(([siteId, link]) => [siteId, link.domain || null]));
	}

	/** Link data that is safe to hand to the renderer. */
	getPublicLink(siteId) {
		const link = this._data.sites[siteId];
		if (!link) return null;
		const { password, ...rest } = link;
		return { ...rest, hasPassword: Boolean(password) };
	}
}

module.exports = { Store };
