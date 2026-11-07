'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC, SPINUPWP_SSH_PORT, spinupwpWebRoot } = require('./constants');
const { SpinupWpApi, API_TOKENS_PAGE } = require('./main/SpinupWpApi');
const { SyncService } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir, TransportError } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

/** A hostname or IPv4 address. It may not start with "-" or ".", so it can never be read as an ssh option. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
/** An SSH username (on SpinupWP, the site user). Same rule: it may not start with "-". */
const USERNAME_RE = /^[a-z0-9_][a-z0-9._-]*$/i;
/** Read at call time, so tests can simulate Windows. */
const isWindows = () => process.platform === 'win32';

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "https://example.com/path" or "user@example.com" -> "example.com". */
const cleanHost = (host) => String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '').split(/[/:]/)[0];

/** A hostname lowercased, or null when it isn't one. */
const cleanDomain = (domain) => {
	const d = String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
	return d && HOSTNAME_RE.test(d) ? d : null;
};

/** The www/non-www twin of a domain: example.com <-> www.example.com. */
const wwwTwin = (domain) => (domain.startsWith('www.') ? domain.slice(4) : `www.${domain}`);

/** Where SpinupWP takes SSH keys (they belong to your account and are attached to site users one by one). */
const SSH_KEYS_PAGE = 'SpinupWP → Account Settings → SSH Keys';
/** Where a site user's keys and password are set. */
const SITE_USER_PAGE = 'the site\'s site user in SpinupWP';

/** An SSH login the server turned down (as opposed to a network error or a missing WordPress). */
const isAuthRefusal = (e) => e instanceof TransportError && (/refused the (SSH key|password)/.test(e.message)
	|| /Permission denied \((publickey|password|keyboard-interactive)|Permission denied, please try again/i.test(e.stderr || ''));

/** SpinupWP site states in which a site can't be reached over SSH yet (or any more). */
const UNLINKABLE_STATES = new Set(['creating', 'deleting', 'failed', 'disabled']);

/** Why a SpinupWP site can't be linked, or null when it can. */
function unlinkableReason(site, server) {
	const state = site.status ? String(site.status).toLowerCase() : null;
	if (site.disabled_at) return 'disabled';
	if (state && UNLINKABLE_STATES.has(state)) return state;
	if (site.is_wordpress === false) return 'not WordPress';
	if (!cleanDomain(site.domain)) return 'no domain';
	if (!USERNAME_RE.test(String(site.site_user || ''))) return 'no site user';
	if (!server || !HOSTNAME_RE.test(String(server.ip_address || ''))) return 'server unknown';
	return null;
}

/**
 * Builds the site picker's choices (IPC.LIST_SITES) from `GET /sites` and `GET /servers`: one per site, grouped by
 * server. Sites that aren't WordPress, are disabled or are still being created are listed but can't be linked.
 */
function toSiteChoices(sites = [], servers = []) {
	const serverById = new Map((servers || []).filter(Boolean).map((sv) => [String(sv.id), sv]));
	return sites
		.filter((site) => site && site.id !== undefined && site.id !== null)
		.map((site) => {
			const server = serverById.get(String(site.server_id)) || null;
			const domain = cleanDomain(site.domain);
			const reason = unlinkableReason(site, server);
			const serverName = (server && (server.name || server.ip_address)) || `Server ${site.server_id}`;
			return {
				id: String(site.id),
				displayName: domain || String(site.id),
				domain,
				url: domain ? `${site.https && site.https.enabled === false ? 'http' : 'https'}://${domain}/` : null,
				siteUser: site.site_user || null,
				serverId: site.server_id !== undefined ? String(site.server_id) : null,
				serverName,
				state: site.status ? String(site.status).toLowerCase() : null,
				linkable: !reason,
				reason,
				group: serverName,
			};
		})
		.sort((a, b) => a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName));
}

/**
 * Domains whose URLs a pull rewrites to the Local site: the site's additional domains, its SpinupWP preview address
 * (`subdomain.url`, e.g. abc123.qal.spinupwp.site, used until the real domain points at the server) and the
 * www/non-www twin.
 */
function altDomainsFor(primary, additionalDomains, previewUrl) {
	const names = (additionalDomains || []).map((d) => cleanDomain(d && typeof d === 'object' ? d.domain : d)).filter(Boolean);
	if (previewUrl) names.push(cleanDomain(cleanHost(previewUrl)));
	if (primary) names.push(wwwTwin(primary));
	return [...new Set(names.filter(Boolean))].filter((d) => d !== primary);
}

module.exports = function SpinupWPConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'spinupwp-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'spinupwp-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	let api = null;
	const getApi = () => {
		if (api) return api;
		const account = store.getAccount();
		if (!account) throw new Error('Connect your SpinupWP account first.');
		api = new SpinupWpApi({ apiKey: account.apiKey, logger });
		return api;
	};

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		getApi: () => (store.getAccount() ? getApi() : null),
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-spinupwp-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => ({
		account: store.getPublicAccount(),
		link: siteId ? store.getPublicLink(siteId) : null,
		activity: siteId ? syncService.activity(siteId) : null,
		publicKey: keys.getPublicKey(),
		passwordAuthSupported: !isWindows(),
		update: updater.state(),
	});

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	/** Discovery hints for a link: where WordPress should be. */
	const hintsFor = (link) => ({
		remotePath: link.remotePath || null,
		webRoot: link.webRoot || null,
		excludeDirs: link.excludeDirs || [],
	});

	/** Locates WordPress over an SSH login, installing WP-CLI if the server lacks it. */
	const locate = async (login, hints, onProgress) => {
		const transport = syncService.transportFor(login);
		try {
			let remote = await syncService.discoverRemote(transport, hints);
			if (!remote.hasWpCli && remote.hasPhp) {
				onProgress('WP-CLI is missing on the server; installing it in a private folder…');
				remote = await syncService.ensureWpCli(transport, remote);
			}
			return remote;
		} finally {
			await transport.close();
		}
	};

	const remoteFields = (remote) => ({
		remotePath: remote.remotePath,
		privateDir: remote.privateDir,
		nested: remote.nested,
		...(remote.managed ? { managed: remote.managed } : {}),
	});

	/**
	 * Logs in with Local's SSH key and finds WordPress. When the server refuses the key and the user typed the site
	 * user's SSH password (for a site user set to password authentication), logs in with that instead and keeps it,
	 * encrypted, in the link. `hints` default to the link's own discovery hints.
	 */
	const connectWithKeyOrPassword = async (link, password, onProgress, hints = hintsFor(link)) => {
		keys.ensure(keyComment());
		onProgress('Connecting with Local\'s SSH key…');
		try {
			return { ...link, authType: 'key', password: null, ...remoteFields(await locate(link, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			logger.info(`SpinupWP refused Local's SSH key for ${link.username}@${link.host}.`);
		}
		const addKeyHint = `Add Local's public key (shown on this page) in ${SSH_KEYS_PAGE}, attach it to ${SITE_USER_PAGE} `
			+ `(${link.username}) with Add SSH Key, then link again.`;
		// Windows has no password field (password logins aren't supported there), so it is checked first.
		if (isWindows()) {
			throw new Error(`SpinupWP refused Local's SSH key, and password authentication is not supported on Windows yet. ${addKeyHint}`);
		}
		if (!password) {
			throw new Error(`The server refused Local's SSH key for the site user ${link.username}. ${addKeyHint} Or, if the site user `
				+ 'uses password authentication, type its password and link again.');
		}
		onProgress('The server refused Local\'s SSH key; connecting with the site user\'s password instead…');
		const withPassword = { ...link, authType: 'password', password };
		try {
			return { ...withPassword, ...remoteFields(await locate(withPassword, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			throw new Error(`The server refused both Local's SSH key and the password for the site user ${link.username}. `
				+ `Password logins only work when ${SITE_USER_PAGE} is set to password authentication. ${addKeyHint}`);
		}
	};

	/**
	 * Links a site chosen from the account's list. The site and its server are read again by id from the API, never
	 * taken from the renderer. Returns the link to store; nothing is saved yet.
	 */
	const prepareAccountLink = async ({ id, password }, onProgress = () => {}) => {
		const spinupwp = getApi();
		if (!id || !/^\d+$/.test(String(id))) throw new Error('Choose a SpinupWP site from the list.');
		onProgress('Reading the site and its server from SpinupWP…');
		const site = await spinupwp.getSite(String(id));
		const server = site ? await spinupwp.getServer(site.server_id) : null;
		const [choice] = toSiteChoices(site ? [site] : [], server ? [server] : []);
		if (!choice) throw new Error('That SpinupWP site could not be found. Refresh the list and try again.');
		if (!choice.linkable) throw new Error(`${choice.displayName} can't be linked (${choice.reason}).`);

		const domain = choice.domain;
		const webRoot = spinupwpWebRoot(domain, site.public_folder);
		const link = {
			mode: 'account',
			platform: 'spinupwp',
			host: String(server.ip_address),
			port: Number(server.ssh_port) || SPINUPWP_SSH_PORT,
			username: String(site.site_user),
			spinupwpSiteId: choice.id,
			spinupwpServerId: choice.serverId,
			serverName: choice.serverName,
			domain,
			directory: '',
			webRoot,
			siteTitle: choice.displayName,
			label: choice.displayName,
			altDomains: altDomainsFor(domain, site.additional_domains, site.subdomain && site.subdomain.enabled !== false ? site.subdomain.url : null),
			excludeDirs: [],
		};
		return connectWithKeyOrPassword(link, password ? String(password) : null, onProgress, { ...hintsFor(link), remotePath: webRoot });
	};

	/** Builds and verifies a link from a server's IP address, SSH port and the site user. Nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }, onProgress = () => {}) => {
		if (authType === 'password' && isWindows()) {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			platform: null,
			authType: authType === 'password' ? 'password' : 'key',
			host: cleanHost(host),
			port: Number(port) || SPINUPWP_SSH_PORT,
			username: String(username || '').trim(),
			password: authType === 'password' ? password : null,
			domain: cleanDomain(cleanHost(domain)),
			altDomains: [],
			excludeDirs: [],
		};
		if (!HOSTNAME_RE.test(link.host)) throw new Error('Enter the server\'s IP address (shown on the server\'s page in SpinupWP).');
		if (!USERNAME_RE.test(link.username)) throw new Error('Enter the site user (shown on the site\'s page in SpinupWP).');
		link.label = link.domain || `${link.username}@${link.host}`;
		if (link.domain) link.altDomains = [wwwTwin(link.domain)];
		onProgress('Connecting over SSH…');
		const typedPath = remotePath ? String(remotePath).trim() : null;
		const webRoot = link.domain ? spinupwpWebRoot(link.domain) : null;
		const remote = await locate(link, { ...hintsFor(link), webRoot, remotePath: typedPath }, onProgress);
		return { ...link, ...remoteFields(remote) };
	};

	const prepareLink = (source, onProgress) => (source && source.kind === 'manual'
		? prepareManualLink(source, onProgress)
		: prepareAccountLink(source || {}, onProgress));

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'spinupwp-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.LINKED_SITES]: () => store.linkedSites(),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ apiKey }) => {
			// Tokens contain no whitespace; copy-paste can bring along spaces, line breaks or zero-width characters.
			const token = String(apiKey || '').replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '');
			if (!token) throw new Error(`Paste an API token from ${API_TOKENS_PAGE}.`);
			const candidate = new SpinupWpApi({ apiKey: token, logger });
			const { sites, servers } = await candidate.validate();
			store.setAccount({ apiKey: token, connectedAt: new Date().toISOString(), sites, servers });
			api = candidate;
			broadcast();
			return getState();
		},

		[IPC.DISCONNECT_ACCOUNT]: () => {
			store.clearAccount();
			api = null;
			broadcast();
			return getState();
		},

		[IPC.LIST_SITES]: async () => {
			const spinupwp = getApi();
			const [sites, servers] = await Promise.all([spinupwp.listSites(), spinupwp.listServers()]);
			return toSiteChoices(sites, servers);
		},

		[IPC.LINK_ACCOUNT_SITE]: async ({ siteId, progressId, id, password }) => {
			store.setLink(siteId, await prepareAccountLink({ id, password }, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, progressId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the SSH connection to SpinupWP first (so a bad login never leaves an empty site
		 * behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = await prepareLink(source, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a SpinupWP pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: ({ siteId }) => {
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to SpinupWP yet.');
			const transport = syncService.transportFor(link);
			try {
				const remote = await syncService.discoverRemote(transport, hintsFor(link));
				store.updateLink(siteId, remoteFields(remote));
				broadcast(siteId);
				return remote;
			} finally {
				await transport.close();
			}
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for SpinupWP loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};

module.exports.toSiteChoices = toSiteChoices;
module.exports.altDomainsFor = altDomainsFor;
