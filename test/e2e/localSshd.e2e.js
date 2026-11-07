'use strict';

/**
 * End-to-end push and pull against a throwaway, unprivileged sshd on 127.0.0.1 that stands in for a site on a SpinupWP
 * server, laid out as SpinupWP lays one out: the site user's home is /sites/<domain>, with the site's files (a full
 * WordPress install, its own wp-config.php and the SpinupWP plugin's object-cache.php drop-in) in ~/files and the
 * site's logs in ~/logs. WP-CLI is a bash wrapper run as plain `wp`: a fake bash `wp` (with the SpinupWP plugin's
 * `spinupwp cache purge-site` command, which only exists while plugins load) and a fake `php` on the remote PATH record
 * every call, and a fake SpinupWP API records cache purges, so the whole files + database pipeline runs through real
 * ssh/rsync (Local's bundled binaries when Local is installed) without touching a real host.
 *
 * Run: node --test test/e2e/localSshd.e2e.js   (macOS/Linux, needs /usr/sbin/sshd)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const LOCAL_RESOURCES = '/Applications/Local.app/Contents/Resources/extraResources';
if (fs.existsSync(LOCAL_RESOURCES)) {
	process.electronPaths = { resourcesPath: LOCAL_RESOURCES };
}

const { SyncService } = require('../../lib/main/SyncService');
const { SshKeyStore } = require('../../lib/main/sshKey');
const { findBundledBinDir } = require('../../lib/main/transport');

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));

/**
 * WP-CLI on a SpinupWP server, as a bash stand-in run as is. It logs every call as it was made, and emulates the
 * handful of commands push and pull use. `spinupwp cache purge-site` is registered by the SpinupWP plugin, so like the
 * real WP-CLI it is unknown when plugins are skipped; it also fails while $FAKE_WP_STATE/plugin-fail exists.
 */
const FAKE_WP = `#!/bin/bash
S="$FAKE_WP_STATE"
echo "wp $*" >> "$S/wp.log"
args=()
skip=""
for a in "$@"; do case "$a" in --skip-plugins) skip=1 ;; --skip-themes) ;; *) args+=("$a") ;; esac; done
set -- "\${args[@]}"
case "$1 $2" in
  "config get") cat "$S/prefix" ;;
  "config set") printf '%s' "$4" > "$S/prefix" ;;
  "db query") if [ "$3" = "SHOW TABLES" ]; then p="$(cat "$S/prefix")"; printf '%soptions\\n%sposts\\n' "$p" "$p"; fi ;;
  "option get") echo "https://shop.example.com" ;;
  "core version") echo "6.8.3" ;;
  "db export") echo "$*" >> "$S/exports.log"
    case "$3" in
      *local-pull-*) printf '%s\\n' '/*M!999999\\- enable the sandbox mode */' \\
        'CREATE TABLE \`wp_options\` (x int) COLLATE=utf8mb4_uca1400_ai_ci;' \\
        "INSERT INTO \\\`wp_options\\\` VALUES ('siteurl','https://shop.example.com');" > "$3" ;;
      *) echo "-- remote backup" > "$3" ;;
    esac ;;
  "db reset") : ;;
  "db import") cp "$3" "$S/imported.sql" ;;
  "cache flush") : ;;
  "spinupwp cache")
    [ -n "$skip" ] && { echo "Error: 'spinupwp' is not a registered wp command." >&2; exit 1; }
    [ -e "$S/plugin-fail" ] && { echo "Error: purge failed" >&2; exit 1; }
    echo "$3" >> "$S/plugin-cache.log" ;;
  *) : ;;
esac
exit 0
`;

/** php with proc_open available; logs calls so the test can show WP-CLI never runs through it. */
const FAKE_PHP = `#!/bin/sh
echo "php $*" >> "$FAKE_WP_STATE/php.log"
if [ "$1" = "-r" ]; then printf yes; exit 0; fi
exit 1
`;

const isLink = (p) => {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch (e) {
		return false;
	}
};

const write = (file, body, mode) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(file, mode);
};

function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

async function waitForPort(port, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const ok = await new Promise((resolve) => {
			const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(true); }).on('error', () => resolve(false));
		});
		if (ok) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`sshd did not start on ${port}`);
}

test('pushes to and pulls from a stand-in SpinupWP site over ssh/rsync', { skip: !SSHD || process.platform === 'win32', timeout: 120000 }, async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-')));
	const dirs = Object.fromEntries(['sshd', 'state', 'bin', 'work', 'local'].map((d) => [d, path.join(root, d)]));
	Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const CORE = ['wp-load.php', 'wp-settings.php', 'wp-includes/version.php', 'wp-admin/index.php'];

	// ---------------------------------------------------------------- "Local" site
	const webRoot = path.join(dirs.local, 'app', 'public');
	write(path.join(webRoot, 'wp-config.php'), '<?php // LOCAL creds');
	write(path.join(webRoot, 'index.php'), '<?php // local index');
	write(path.join(webRoot, 'local-notes.txt'), 'a root file, synced like any other');
	CORE.forEach((f) => write(path.join(webRoot, f), '<?php // local core'));
	write(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme */');
	write(path.join(webRoot, 'wp-content', 'private-mode.php'), '<?php // 600 locally', 0o600);
	write(path.join(webRoot, 'wp-content', 'object-cache.php'), '<?php // local cache dropin');
	write(path.join(webRoot, '.spinupwp-push-ignore'), 'secret-notes.txt\n');
	write(path.join(webRoot, 'wp-content', 'secret-notes.txt'), 'do not push');
	// A child theme developed in another folder and symlinked into the site, plus a link whose target is gone.
	const devTheme = path.join(root, 'dev', 'mytheme');
	write(path.join(devTheme, 'style.css'), '/* Theme Name: Mine Child */');
	write(path.join(devTheme, 'assets', 'app.css'), 'body{color:#87a8ed}');
	fs.symlinkSync(devTheme, path.join(webRoot, 'wp-content', 'themes', 'mine-child'));
	fs.symlinkSync(path.join(root, 'dev', 'deleted-plugin'), path.join(webRoot, 'wp-content', 'themes', 'gone'));

	// ---------------------------------------------------------------- "SpinupWP" site: /sites/<domain>
	const home = path.join(root, 'sites', 'shop.example.com');
	const remoteWeb = path.join(home, 'files');
	write(path.join(home, 'logs', 'access.log'), 'GET / 200');
	write(path.join(remoteWeb, 'wp-config.php'), '<?php // SPINUPWP creds');
	write(path.join(remoteWeb, '.user.ini'), 'memory_limit=256M');
	write(path.join(remoteWeb, 'index.php'), '<?php // remote index');
	CORE.forEach((f) => write(path.join(remoteWeb, f), '<?php // remote core'));
	write(path.join(remoteWeb, 'google1234.html'), 'google-site-verification');
	write(path.join(remoteWeb, 'wp-content', 'object-cache.php'), '<?php // spinupwp redis object cache');
	write(path.join(remoteWeb, 'wp-content', 'plugins', 'spinupwp', 'spinupwp.php'), '<?php // SpinupWP plugin');
	write(path.join(remoteWeb, 'wp-content', 'mu-plugins', 'host-only.php'), '<?php // installed on the server');
	write(path.join(remoteWeb, 'wp-content', 'stale.php'), '<?php // stale');
	// An existing server file with its own permissions, which a push must not reset.
	write(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), '/* old remote theme */', 0o640);
	fs.writeFileSync(path.join(dirs.state, 'prefix'), 'wp_');

	fs.writeFileSync(path.join(dirs.bin, 'wp'), FAKE_WP, { mode: 0o755 });
	fs.writeFileSync(path.join(dirs.bin, 'php'), FAKE_PHP, { mode: 0o755 });

	// Key the user added in SpinupWP → Account Settings → SSH Keys and attached to the site user
	const keys = new SshKeyStore(path.join(dirs.work, 'ssh'));
	fs.writeFileSync(path.join(dirs.sshd, 'authorized_keys'), `${keys.ensure('e2e')}\n`, { mode: 0o600 });

	const port = await freePort();
	const hostKey = path.join(dirs.sshd, 'host_ed25519');
	execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
	const remotePath = [dirs.bin, findBundledBinDir(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
	fs.writeFileSync(path.join(dirs.sshd, 'sshd_config'), [
		`Port ${port}`,
		'ListenAddress 127.0.0.1',
		`HostKey ${hostKey}`,
		`PidFile ${path.join(dirs.sshd, 'sshd.pid')}`,
		`AuthorizedKeysFile ${path.join(dirs.sshd, 'authorized_keys')}`,
		'PasswordAuthentication no',
		'KbdInteractiveAuthentication no',
		'UsePAM no',
		'StrictModes no',
		`SetEnv PATH=${remotePath} FAKE_WP_STATE=${dirs.state} HOME=${home}`,
		'',
	].join('\n'));
	const sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dirs.sshd, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
	let sshdLog = '';
	sshd.stderr.on('data', (d) => { sshdLog += d; });
	t.after(() => sshd.kill());
	await waitForPort(port);

	const events = [];
	const site = { id: 'site1', name: 'Shop', domain: 'shop.local', paths: { webRoot, sql: path.join(dirs.local, 'app', 'sql') } };
	const localWpCalls = [];
	// Linked through the SpinupWP API: no remote path yet, so discovery starts from the webRoot hint.
	const link = {
		mode: 'account',
		platform: 'spinupwp',
		host: '127.0.0.1',
		port,
		username: os.userInfo().username,
		authType: 'key',
		spinupwpSiteId: '1234567',
		spinupwpServerId: '9',
		serverName: 'web-1',
		domain: 'shop.example.com',
		directory: '',
		webRoot: remoteWeb,
		label: 'shop.example.com',
		altDomains: ['www.shop.example.com'],
		excludeDirs: [],
	};
	let storedLink = { ...link };
	const apiCalls = [];
	let pagePurgeError = null;
	const fakeApi = {
		purgePageCache: async (siteId) => {
			apiCalls.push(['purgePageCache', siteId]);
			if (pagePurgeError) throw pagePurgeError;
			return 77;
		},
		purgeObjectCache: async (siteId) => { apiCalls.push(['purgeObjectCache', siteId]); return 78; },
		waitForEvent: async (id) => { apiCalls.push(['waitForEvent', id]); return { id, status: 'deployed' }; },
	};
	const service = new SyncService({
		store: {
			getLink: () => storedLink,
			updateLink: (id, patch) => { storedLink = { ...storedLink, ...patch }; },
		},
		keys,
		workDir: dirs.work,
		getApi: () => fakeApi,
		services: {
			siteData: { getSite: () => site },
			siteDatabase: {
				dump: async (_site, dest) => fs.writeFileSync(dest, [
					'CREATE TABLE `wp_options` (x int) COLLATE=utf8mb4_0900_ai_ci;',
					"INSERT INTO `wp_options` VALUES ('siteurl','http://shop.local');",
				].join('\n')),
				getTablePrefix: async () => 'wplocal_',
			},
			siteProcessManager: { getSiteStatus: () => 'running', start: async () => {} },
			// Stand-in for Local's WpCliService.run(site, args)
			wpCli: {
				run: async (_site, args) => {
					localWpCalls.push(args.join(' '));
					if (args.join(' ') === 'option get home') return 'http://shop.local\n';
					if (args.join(' ') === 'core version') return '6.8.3\n';
					if (args[0] === 'db' && args[1] === 'import') fs.copyFileSync(args[2], path.join(dirs.state, 'local-imported.sql'));
					return '';
				},
			},
		},
		sendIPCEvent: (...args) => events.push(args),
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	const run = async (promise) => {
		try {
			return await promise;
		} catch (e) {
			return assert.fail(`${e.message}\n--- sshd ---\n${sshdLog}`);
		}
	};
	const readLog = (name) => {
		const f = path.join(dirs.state, name);
		return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
	};
	const wpLog = () => readLog('wp.log');
	const exportsLog = () => readLog('exports.log');
	const PLAIN_WP = 'wp --skip-plugins --skip-themes ';
	const homeEntries = ['.spinupwp-connect', 'files', 'logs'];
	const remoteRootEntries = ['.user.ini', 'index.php', 'local-notes.txt', 'wp-admin', 'wp-config.php', 'wp-content', 'wp-includes', 'wp-load.php', 'wp-settings.php'];

	// ---------------------------------------------------------------- push
	let result = await run(service.push('site1'));
	assert.equal(result.ok, true);
	assert.deepEqual(result.warnings, []);
	// The whole push (discovery, rsync, a dozen WP-CLI calls) uses one SSH connection.
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((sshdLog.match(/Accepted publickey/g) || []).length, 1, sshdLog);

	// Discovery: the hinted webroot, no server-managed links, no nested sites.
	assert.equal(storedLink.remotePath, remoteWeb);
	assert.deepEqual(storedLink.managed, []);
	assert.deepEqual(storedLink.nested, []);

	// The whole webroot moved: core, index.php and root files; the server keeps its own wp-config.php, .user.ini and
	// object-cache.php drop-in, and --delete removed the remote-only root file and the stale file.
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries);
	CORE.forEach((f) => assert.equal(fs.readFileSync(path.join(remoteWeb, f), 'utf8'), '<?php // local core', `${f} is pushed`));
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'index.php'), 'utf8'), '<?php // local index');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'local-notes.txt'), 'utf8'), 'a root file, synced like any other');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // SPINUPWP creds');
	assert.equal(fs.readFileSync(path.join(remoteWeb, '.user.ini'), 'utf8'), 'memory_limit=256M');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'object-cache.php'), 'utf8'), '<?php // spinupwp redis object cache');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'google1234.html')), 'remote-only root files are deleted like any other');
	assert.ok(!fs.existsSync(path.join(remoteWeb, '.spinupwp-push-ignore')), 'ignore files stay in Local');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), 'utf8'), '/* theme */');
	assert.ok(fs.existsSync(path.join(remoteWeb, 'wp-content', 'mu-plugins', 'host-only.php')), 'remote-only must-use plugins are never deleted');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'stale.php')), 'stale remote file should be deleted');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'plugins', 'spinupwp')), 'a plugin only on the server is deleted (it is not in Local)');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'secret-notes.txt')), '.spinupwp-push-ignore should apply');
	// No --perms: updated files keep the server's mode; new files get the --chmod defaults.
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css')).mode & 0o777, 0o640);
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'private-mode.php')).mode & 0o777, 0o644);
	// A theme symlinked from outside the site arrives as real files; a broken link is skipped, not fatal.
	const remoteChild = path.join(remoteWeb, 'wp-content', 'themes', 'mine-child');
	assert.ok(!isLink(remoteChild), 'linked theme must be copied, not sent as a dangling link');
	assert.equal(fs.readFileSync(path.join(remoteChild, 'assets', 'app.css'), 'utf8'), 'body{color:#87a8ed}');
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'themes', 'gone')) && !isLink(path.join(remoteWeb, 'wp-content', 'themes', 'gone')));

	// Database: backup in a private folder in the site user's home, outside ~/files, named after the webroot's path
	// in the home plus a checksum; only this site's tables, collations rewritten, temp dump cleaned up.
	const cksum = execFileSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d " " -f 1', 'sh', remoteWeb], { encoding: 'utf8' }).trim();
	const privateDir = path.join(home, '.spinupwp-connect', `files-${cksum}`);
	assert.equal(storedLink.privateDir, privateDir);
	assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.dirname(privateDir)).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(home).sort(), homeEntries, 'nothing else is written in the home');
	assert.equal(fs.readFileSync(path.join(home, 'logs', 'access.log'), 'utf8'), 'GET / 200');
	assert.deepEqual(fs.readdirSync(privateDir), ['local-backup-before-push.sql'], 'temporary dumps are removed');
	assert.match(exportsLog()[0], new RegExp(`^db export ${privateDir}/local-backup-before-push\\.sql --tables=wp_options,wp_posts --no-tablespaces=true$`));
	const imported = fs.readFileSync(path.join(dirs.state, 'imported.sql'), 'utf8');
	assert.ok(imported.includes('utf8mb4_unicode_520_ci') && !imported.includes('0900'));

	const pushWp = wpLog();
	// WP-CLI is a bash wrapper: run as plain `wp`, never through php, always without plugins and themes.
	assert.ok(pushWp.every((l) => l.startsWith(PLAIN_WP)), pushWp.join('\n'));
	const phpLog = readLog('php.log');
	assert.ok(phpLog.every((l) => l.startsWith('php -r')), `only the proc_open check uses php:\n${phpLog.join('\n')}`);
	const wpArgs = pushWp.map((l) => l.slice(PLAIN_WP.length));
	assert.ok(wpArgs.includes('db reset --yes'));
	assert.ok(wpArgs.some((a) => a.startsWith(`db import ${privateDir}/local-push-`)));
	assert.ok(wpArgs.includes('config set table_prefix wplocal_'));
	assert.equal(fs.readFileSync(path.join(dirs.state, 'prefix'), 'utf8'), 'wplocal_');
	assert.ok(wpArgs.includes('search-replace //shop.local //shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(wpArgs.includes('search-replace \\/\\/shop.local \\/\\/shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	assert.ok(wpArgs.includes('search-replace http://shop.example.com https://shop.example.com --all-tables --precise --skip-columns=guid --report-changed-only'));
	// Caches last: WordPress's object cache with WP-CLI, then SpinupWP's page and object caches through the API (the
	// plugin's purge command is not needed for an account link).
	assert.equal(wpArgs[wpArgs.length - 1], 'cache flush');
	assert.ok(!pushWp.some((l) => / spinupwp cache /.test(l)));
	assert.deepEqual(apiCalls.filter(([name]) => name !== 'waitForEvent').sort(), [['purgeObjectCache', '1234567'], ['purgePageCache', '1234567']]);
	assert.deepEqual(apiCalls.filter(([name]) => name === 'waitForEvent').map(([, id]) => id).sort(), [77, 78], 'each purge is waited on');

	// Site overlay lifecycle mirrors Local Connect
	const statuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , s]) => s);
	assert.equal(statuses[0], 'pushing_v2');
	assert.equal(statuses[statuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'spinupwp-site-pushed' && banner.variant === 'success'));

	// ---------------------------------------------------------------- push when the API can't purge the page cache
	apiCalls.length = 0;
	pagePurgeError = new Error('cache daemon not running');
	result = await run(service.push('site1', { database: false }));
	pagePurgeError = null;
	assert.equal(result.warnings.length, 1, result.warnings.join('\n'));
	assert.match(result.warnings[0], /^SpinupWP's page cache was not purged: cache daemon not running/);
	assert.ok(apiCalls.some(([name]) => name === 'purgeObjectCache'), 'the object cache is still purged');
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries);

	// ---------------------------------------------------------------- push over a manual link (no API)
	const accountLink = storedLink;
	storedLink = { ...accountLink, mode: 'manual', platform: null, spinupwpSiteId: undefined, spinupwpServerId: undefined };
	apiCalls.length = 0;
	fs.writeFileSync(path.join(dirs.state, 'wp.log'), '');
	result = await run(service.push('site1', { database: false }));
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(apiCalls, [], 'a manual link never uses the API');
	assert.ok(wpLog().some((l) => / spinupwp cache purge-site/.test(l)), wpLog().join('\n'));
	assert.deepEqual(readLog('plugin-cache.log'), ['purge-site'], 'the SpinupWP plugin purged the page cache');

	fs.writeFileSync(path.join(dirs.state, 'plugin-fail'), '');
	result = await run(service.push('site1', { database: false }));
	fs.rmSync(path.join(dirs.state, 'plugin-fail'));
	assert.equal(result.warnings.length, 1, result.warnings.join('\n'));
	assert.match(result.warnings[0], /^SpinupWP's page cache could not be purged/);
	storedLink = { ...accountLink, ...storedLink, mode: 'account', platform: 'spinupwp', spinupwpSiteId: '1234567', spinupwpServerId: '9' };

	// ---------------------------------------------------------------- pull
	write(path.join(remoteWeb, 'wp-content', 'uploads', 'photo.jpg'), 'jpeg');
	write(path.join(remoteWeb, 'wp-includes', 'version.php'), '<?php // remote core, updated');
	write(path.join(remoteWeb, 'wp-content', 'plugins', 'spinupwp', 'spinupwp.php'), '<?php // SpinupWP plugin');
	write(path.join(webRoot, 'wp-content', 'local-only.php'), '<?php // only in local');
	write(path.join(remoteChild, 'server-edit.css'), '/* edited on the server */');
	fs.writeFileSync(path.join(dirs.state, 'exports.log'), '');
	events.length = 0;

	result = await run(service.pull('site1'));
	assert.equal(result.ok, true);
	assert.deepEqual(result.warnings, []);

	// Files: remote files arrive, core included; Local keeps its own wp-config.php and object-cache.php.
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'uploads', 'photo.jpg'), 'utf8'), 'jpeg');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-includes', 'version.php'), 'utf8'), '<?php // remote core, updated');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'plugins', 'spinupwp', 'spinupwp.php'), 'utf8'), '<?php // SpinupWP plugin');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-config.php'), 'utf8'), '<?php // LOCAL creds');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'object-cache.php'), 'utf8'), '<?php // local cache dropin');
	assert.ok(!fs.existsSync(path.join(webRoot, '.user.ini')), 'server config stays on the server');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-content', 'mu-plugins', 'host-only.php'), 'utf8'), '<?php // installed on the server');
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'local-only.php')), 'local-only file should be deleted');
	assert.ok(fs.existsSync(path.join(webRoot, '.spinupwp-push-ignore')), 'Local\'s ignore file is kept');
	// Nothing a pull replaces or deletes is lost: it is moved to app/spinupwp-backups/pull-<time>/.
	const backupsDir = path.join(dirs.local, 'app', 'spinupwp-backups');
	const latestBackup = () => path.join(backupsDir, fs.readdirSync(backupsDir).sort().pop());
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-content', 'local-only.php'), 'utf8'), '<?php // only in local');
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-includes', 'version.php'), 'utf8'), '<?php // local core');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && /were saved in app\/spinupwp-backups\/pull-/.test(banner.message)));
	// The linked theme is Local-owned: the link stays, and nothing is written into or deleted from its real folder.
	assert.ok(isLink(path.join(webRoot, 'wp-content', 'themes', 'mine-child')));
	assert.deepEqual(fs.readdirSync(devTheme).sort(), ['assets', 'style.css']);
	assert.ok(isLink(path.join(webRoot, 'wp-content', 'themes', 'gone')), 'broken link left alone');
	fs.rmSync(path.join(remoteChild, 'server-edit.css'));
	// The pull changed nothing on the server, and wrote nothing new in the home.
	assert.deepEqual(fs.readdirSync(remoteWeb).sort(), remoteRootEntries);
	assert.deepEqual(fs.readdirSync(home).sort(), homeEntries);

	// Database: only this site's tables exported, Local backed up first, MariaDB dump normalized for MySQL, URLs rewritten.
	assert.match(exportsLog()[0], new RegExp(`^db export ${privateDir}/local-pull-[0-9a-f]+\\.sql --tables=wplocal_options,wplocal_posts --no-tablespaces=true --single-transaction --quick --lock-tables=false$`));
	assert.ok(fs.existsSync(path.join(dirs.local, 'app', 'sql', 'local-backup-before-pull.sql')));
	const pulledSql = fs.readFileSync(path.join(dirs.state, 'local-imported.sql'), 'utf8');
	assert.ok(!pulledSql.includes('sandbox mode') && !pulledSql.includes('uca1400'));
	assert.ok(pulledSql.includes("'siteurl','https://shop.example.com'"));
	assert.deepEqual(localWpCalls.slice(0, 3), ['core version', 'option get home', 'db reset --yes']);
	assert.match(localWpCalls[3], /^db import .+spinupwp-pull-site1-[0-9a-f]+\.sql$/);
	const sr = (from, to) => `search-replace ${from} ${to} --all-tables --precise --skip-columns=guid --report-changed-only`;
	assert.deepEqual(localWpCalls.filter((c) => c.startsWith('search-replace ')), [
		sr('//shop.example.com', '//shop.local'),
		sr('\\/\\/shop.example.com', '\\/\\/shop.local'),
		sr('//www.shop.example.com', '//shop.local'),
		sr('\\/\\/www.shop.example.com', '\\/\\/shop.local'),
		sr('https://shop.local', 'http://shop.local'),
	]);
	assert.ok(!localWpCalls.some((c) => c.startsWith('config set')), 'prefixes already match after the push');
	assert.deepEqual(fs.readdirSync(privateDir), ['local-backup-before-push.sql'], 'remote export cleaned up');

	const pullStatuses = events.filter(([name]) => name === 'updateSiteStatus').map(([, , st]) => st);
	assert.equal(pullStatuses[0], 'pulling');
	assert.equal(pullStatuses[pullStatuses.length - 1], 'running');
	assert.ok(events.some(([name, banner]) => name === 'showSiteBanner' && banner.id === 'spinupwp-site-pulled'));
	assert.ok(events.some(([name]) => name === 'refreshSiteVersions'));
	assert.ok(storedLink.lastPull && storedLink.lastPush);

	// ---------------------------------------------------------------- compare & selective sync
	const later = new Date(Date.now() + 120000);
	write(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), '/* theme v2, edited locally */');
	fs.utimesSync(path.join(webRoot, 'wp-content', 'themes', 'mine', 'style.css'), later, later);
	write(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php'), '<?php // new plugin');
	write(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg'), 'jpeg2');
	// Root files are part of the comparison too; server config and the drop-in never are.
	write(path.join(remoteWeb, 'robots.txt'), 'User-agent: *');
	write(path.join(remoteWeb, 'wp-config.php'), '<?php // SPINUPWP creds, edited');

	let comparison = await run(service.compare('site1'));
	const summary = (c) => c.entries.map((e) => [e.path, e.status, e.newer]);
	assert.deepEqual(summary(comparison), [
		['robots.txt', 'remote-only', null],
		['wp-content/plugins/p/new.php', 'local-only', null],
		['wp-content/themes/mine/style.css', 'changed', 'local'],
		['wp-content/uploads/remote only.jpg', 'remote-only', null],
	], 'excluded files (wp-config.php, .user.ini, object-cache.php, ignore-listed) never appear');
	const styleEntry = comparison.entries[2];
	assert.equal(styleEntry.local.size, '/* theme v2, edited locally */'.length);
	assert.equal(styleEntry.remote.size, '/* theme */'.length);

	await assert.rejects(service.push('site1', { fileList: ['wp-config.php'] }), /out of date/);
	comparison = await run(service.compare('site1'));

	// Push two: the edited stylesheet goes up and the remote-only upload is deleted on the server.
	result = await run(service.push('site1', {
		fileList: ['wp-content/themes/mine/style.css', 'wp-content/uploads/remote only.jpg'],
	}));
	assert.deepEqual(result.warnings, []);
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css'), 'utf8'), '/* theme v2, edited locally */');
	assert.equal(fs.statSync(path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css')).mode & 0o777, 0o640);
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'uploads', 'remote only.jpg')));
	assert.ok(!fs.existsSync(path.join(remoteWeb, 'wp-content', 'plugins', 'p', 'new.php')), 'unselected file stays put');
	assert.equal(fs.readFileSync(path.join(remoteWeb, 'wp-config.php'), 'utf8'), '<?php // SPINUPWP creds, edited');
	assert.equal(storedLink.lastPush.selectedFiles, 2);

	comparison = await run(service.compare('site1'));
	assert.deepEqual(summary(comparison), [
		['robots.txt', 'remote-only', null],
		['wp-content/plugins/p/new.php', 'local-only', null],
	]);

	// Pull the remaining two: robots.txt arrives, and the plugin that does not exist on SpinupWP is removed locally
	// (and kept in the pull backup).
	await run(service.pull('site1', { fileList: ['robots.txt', 'wp-content/plugins/p/new.php'] }));
	assert.equal(fs.readFileSync(path.join(webRoot, 'robots.txt'), 'utf8'), 'User-agent: *');
	assert.ok(!fs.existsSync(path.join(webRoot, 'wp-content', 'plugins', 'p', 'new.php')));
	assert.equal(fs.readFileSync(path.join(latestBackup(), 'wp-content', 'plugins', 'p', 'new.php'), 'utf8'), '<?php // new plugin');
	assert.equal(fs.readFileSync(path.join(webRoot, 'wp-config.php'), 'utf8'), '<?php // LOCAL creds');
	assert.ok(fs.readdirSync(backupsDir).length <= 3, 'only the last 3 pull backups are kept');
	assert.deepEqual((await run(service.compare('site1'))).entries, []);

	// Checksum mode catches same-size, same-mtime edits that the quick check cannot see
	const remoteStyle = path.join(remoteWeb, 'wp-content', 'themes', 'mine', 'style.css');
	const stamp = fs.statSync(remoteStyle).mtime;
	fs.writeFileSync(remoteStyle, '/* theme v2, edited remotely */'.slice(0, '/* theme v2, edited locally */'.length));
	fs.utimesSync(remoteStyle, stamp, stamp);
	assert.deepEqual((await run(service.compare('site1'))).entries, []);
	assert.deepEqual(summary(await run(service.compare('site1', { checksum: true }))), [['wp-content/themes/mine/style.css', 'changed', 'same']]);

	// A pull into a Local site whose core is gone stops before the database is touched.
	fs.rmSync(path.join(webRoot, 'wp-settings.php'));
	await assert.rejects(service.pull('site1', { files: false }), /WordPress core is missing.*database was not changed/);
});
