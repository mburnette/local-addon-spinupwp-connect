'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { SYNC_EXCLUDES, SYNC_PROTECT, IGNORE_FILES, WP_CLI_PHAR_URL } = require('../constants');
const { Transport, TransportError, describeSshFailure, shellQuote: q, toPosixPath } = require('./transport');

/** WP-CLI on the server, without plugins or themes so a broken one cannot stop a transfer. */
const wpCommand = (remote) => `${remote.wp} --skip-plugins --skip-themes`;

/**
 * Shell snippet (run after `cd` into the webroot) that sets $p to the site's table prefix, $a to every table in its
 * database (one per line) and $o to the comma-separated tables with the prefix (empty when either is unknown). A
 * database can hold several WordPress sites with different prefixes, so exports are limited to "$o" with
 * `${o:+--tables="$o"}`: a pull never downloads another site's tables, and the push backup holds only this site's.
 */
const tableListSnippet = (WP) => `{ p="$(${WP} config get table_prefix 2>/dev/null)"; `
	+ `a="$(${WP} db query 'SHOW TABLES' --skip-column-names 2>/dev/null)"; `
	+ `o="$(printf '%s\\n' "$a" | awk -v p="$p" 'p != "" && index($0, p) == 1' | paste -s -d , -)"; true; }`;
const PREFIX_TABLES_ARG = '${o:+--tables="$o"}';
/** A table name that is safe to put in a DROP TABLE statement between backticks. */
const SAFE_TABLE_NAME = /^[A-Za-z0-9_$-]+$/;
const REMOTE_BACKUP_NAME = 'local-backup-before-push.sql';
const LOCAL_BACKUP_NAME = 'local-backup-before-pull.sql';
/** Folder beside the Local webroot that keeps the files each pull replaced or deleted, and how many pulls to keep. */
const FILE_BACKUP_FOLDER = 'spinupwp-backups';
const FILE_BACKUPS_KEPT = 3;
const MARIADB_SANDBOX_LINE = /^\/\*M!999999\\- enable the sandbox mode \*\/\s*$/;

const DEFAULT_OPTIONS = {
	push: {
		files: true,
		database: true,
		deleteRemote: true,
		purgeCache: true,
	},
	pull: {
		files: true,
		database: true,
		backupLocal: true,
		deleteLocal: true,
	},
};

const LABELS = {
	push: { status: 'pushing_v2', verb: 'push', gerund: 'pushing', preposition: 'to', done: 'pushed to' },
	pull: { status: 'pulling', verb: 'pull', gerund: 'pulling', preposition: 'from', done: 'pulled from' },
};

/**
 * Makes a dump importable on the other side. Local runs MySQL 8 and a server may run MariaDB 11, and each side's
 * default collations (utf8mb4_0900_* / utf8mb4_uca1400_*) are unknown to the other. Newer MariaDB mysqldump also
 * writes a "sandbox mode" first line that the MySQL client rejects. Streams line by line so large dumps are not
 * loaded into memory.
 */
async function normalizeDumpForImport(file) {
	const tmp = `${file}.tmp`;
	const input = fs.createReadStream(file, { encoding: 'utf8' });
	const output = fs.createWriteStream(tmp, { encoding: 'utf8' });
	const rl = readline.createInterface({ input, crlfDelay: Infinity });
	for await (const line of rl) {
		if (MARIADB_SANDBOX_LINE.test(line)) continue;
		const fixed = line
			.replace(/utf8mb4_(?:0900|uca1400)_[a-z0-9_]+/g, 'utf8mb4_unicode_520_ci')
			.replace(/utf8mb3_uca1400_[a-z0-9_]+/g, 'utf8mb3_unicode_ci');
		if (!output.write(`${fixed}\n`)) {
			await new Promise((resolve) => output.once('drain', resolve));
		}
	}
	await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())));
	fs.renameSync(tmp, file);
}

/** Parses `key=value` lines printed by our remote helper commands. */
function parseKeyValues(stdout) {
	return stdout.split(/\r?\n/).reduce((acc, line) => {
		const i = line.indexOf('=');
		if (i > 0) acc[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		return acc;
	}, {});
}

/** A webroot-relative path from a comparison: no absolute paths, no "..", no empty segments. */
const isSafeRelativePath = (p) => typeof p === 'string'
	&& p.length > 0
	&& !p.startsWith('/')
	&& !/^[A-Za-z]:/.test(p)
	&& !p.includes('\0')
	&& p.split(/[\\/]/).every((seg) => seg && seg !== '..' && seg !== '.');

/** True when webroot-relative `p` is one of `dirs` or inside one of them. */
const isUnderAny = (p, dirs) => dirs.some((d) => p === d || p.startsWith(`${d}/`));

/** "https://example.com/blog/" -> "//example.com/blog" */
const schemeless = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/^https?:/i, '');

/**
 * Search/replace pairs that move a site from one base URL to another, the same scheme-relative replacement
 * Local Connect uses for WP Engine, plus the JSON-escaped form block editors and page builders store, plus a
 * final scheme fix when the destination's scheme differs.
 */
function urlReplacements(fromBases, toUrl) {
	const to = schemeless(toUrl);
	const pairs = [];
	[...new Set(fromBases.map(schemeless))].filter((from) => from && from !== to).forEach((from) => {
		pairs.push([from, to]);
		pairs.push([from.replace(/\//g, '\\/'), to.replace(/\//g, '\\/')]);
	});
	const host = to.replace(/^\/\//, '');
	if (/^https:/i.test(toUrl)) pairs.push([`http://${host}`, `https://${host}`]);
	else if (/^http:/i.test(toUrl)) pairs.push([`https://${host}`, `http://${host}`]);
	return pairs;
}

/** An absolute server path with at least one segment and no "." or ".." segments. */
const isSafeAbsolutePath = (p) => typeof p === 'string'
	&& p.startsWith('/')
	&& !p.includes('\0')
	&& p.replace(/\/+$/, '').length > 0
	&& p.split('/').every((seg) => seg !== '..' && seg !== '.');

/**
 * Shell snippet that finds the WordPress webroot for the SSH user and a private working directory outside it for
 * backups, temporary dumps and a downloaded WP-CLI (never inside the webroot, so a dump is never web-downloadable).
 *
 * On SpinupWP each site has its own site user, whose home folder is /sites/<domain> with the site's files (a full
 * WordPress install) in ~/files. Candidates, in order: the stored `remotePath` (used as is, with no fallback), else
 * the `webRoot` hint (from the API's domain and public folder), ~/files, ~/public_html and the home folder itself.
 *
 * The private folder is ~/.spinupwp-connect/<slug>, where the slug is the webroot's path inside the home folder with
 * "/" turned into "_", plus a checksum of the full path so two webroots never share a folder ("site-<checksum>" alone
 * when the webroot is not inside the home folder). On SpinupWP that is ~/.spinupwp-connect/files-<checksum>. It falls back to the folder above the webroot,
 * unless that is another website's public folder, then to TMPDIR with the user id in the folder name.
 *
 * It also prints `nested=<relative path>` for every other WordPress install inside the webroot, so transfers can
 * exclude them, and `managed=<relative path>` for links that resolve outside the webroot (a push never replaces them). `procopen=no` means PHP's proc_open is disabled for the CLI, which breaks WP-CLI's
 * database commands unless it runs as `php -d disable_functions= <wp>`; `wppath`/`wpphp` say where `wp` is and whether
 * it is a PHP file that can be run that way (a shell wrapper is used as is).
 */
function discoverRemoteScript({ remotePath, webRoot } = {}) {
	// A stored or chosen path is used as is: falling back to another folder could push to the wrong site.
	const root = String(webRoot || '').trim();
	const hinted = [];
	if (isSafeAbsolutePath(root)) hinted.push(q(root.replace(/\/+$/, '')));
	const candidates = remotePath ? [q(remotePath)] : [...hinted, '"$HOME/files"', '"$HOME/public_html"', '"$HOME"'];
	return [
		`for d in ${candidates.join(' ')}; do`,
		'if [ -f "$d/wp-config.php" ] || [ -f "$d/wp-load.php" ]; then',
		'cd "$d" && W="$(pwd -P)"; H="$(cd "$HOME" 2>/dev/null && pwd -P)"; T="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)"; P="";',
		// Per-site folder name: the webroot's path inside the home folder, made unique by a checksum of the full path
		// ("a/b_c" and "a_b/c" would otherwise both become "a_b_c").
		'K="$(printf %s "$W" | cksum | cut -d " " -f 1)";',
		'case "$W" in "$H"/*) S="$(printf %s "${W#"$H"/}" | tr / _)-$K";; *) S="site-$K";; esac;',
		'for b in "$H" "$(dirname "$W")" "$T"; do',
		'b="$(cd "$b" 2>/dev/null && pwd -P)"; [ -n "$b" ] || continue; case "$b/" in "$W"/*) continue;; esac;',
		// The folder above the webroot is skipped when it is a website's public folder or inside one (a WordPress installed
		// in a subfolder sits inside its parent website's webroot, which would serve the dumps).
		'[ "$b" != "$H" ] && [ "$b" != "$T" ] && { [ -f "$b/wp-config.php" ] || [ -f "$b/wp-load.php" ] || case "$b/" in */public_html/*|*/files/*) true;; *) false;; esac; } && continue;',
		'c="$b/.spinupwp-connect"; [ "$b" = "$T" ] && c="$b/.spinupwp-connect-$(id -u)";',
		// Only folders this user owns: in a shared temp folder another user could have made (and could swap) the folder.
		'if (umask 077; mkdir -p "$c/$S") 2>/dev/null && [ -w "$c/$S" ] && [ -O "$c" ] && [ -O "$c/$S" ]; then chmod 700 "$c" "$c/$S" 2>/dev/null; P="$c/$S"; break; fi; done;',
		'echo "webroot=$W"; echo "private=$P";',
		'if command -v wp >/dev/null 2>&1; then echo "wpcli=wp"; f="$(command -v wp)"; echo "wppath=$f";',
		// A PHP file starts with a shebang whose interpreter is php (the WP-CLI phar: "#!/usr/bin/env php") or with
		// "<?php"; anything else (a shell wrapper) is run as is.
		'if head -n 1 "$f" 2>/dev/null | grep -qE \'^#![[:space:]]*([^[:space:]]*/)?(env[[:space:]]+)?php[^[:space:]/]*([[:space:]]|$)|^<[?]php\';',
		'then echo "wpphp=yes"; else echo "wpphp=no"; fi;',
		'elif [ -n "$P" ] && [ -f "$P/wp-cli.phar" ] && command -v php >/dev/null 2>&1; then echo "wpcli=phar"; else echo "wpcli=no"; fi;',
		'if command -v php >/dev/null 2>&1; then echo "php=yes";',
		'echo "procopen=$(php -r \'echo function_exists("proc_open") ? "yes" : "no";\' 2>/dev/null)"; else echo "php=no"; fi;',
		'if command -v rsync >/dev/null 2>&1; then echo "rsync=yes"; else echo "rsync=no"; fi;',
		'find "$W" -maxdepth 4 \\( -name wp-content -o -name node_modules -o -name .git \\) -prune -o -name wp-load.php ! -path "$W/wp-load.php" -print 2>/dev/null',
		'| while IFS= read -r f; do r="$(dirname "$f")"; echo "nested=${r#"$W"/}"; done;',
		// Links that resolve outside the site belong to the server (shared plugins or drop-ins): a push never replaces them.
		'find "$W" -maxdepth 3 \\( -name node_modules -o -name .git \\) -prune -o -type l -print 2>/dev/null | while IFS= read -r l; do',
		't="$(readlink -f "$l" 2>/dev/null)"; case "$t" in "$W"/*) ;; *) echo "managed=${l#"$W"/}";; esac; done;',
		'exit 0; fi; done;',
		'echo "home=$HOME"; exit 3',
	].join(' ');
}

/**
 * Symlinks in a Local site that rsync treats as unsafe (absolute, or climbing out of the webroot): typically a theme
 * or plugin developed in another folder and linked into wp-content. Paths are webroot-relative with "/" separators.
 * `external` links are pushed as the files they point to (--copy-unsafe-links) but never pulled into, so a pull can
 * neither replace the link nor write into the folder it points to. `broken` ones have no target and are skipped.
 */
function findExternalLinks(webRoot) {
	const external = [];
	const broken = [];
	let root;
	try {
		root = fs.realpathSync(webRoot);
	} catch (e) {
		return { external, broken };
	}
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		entries.forEach((entry) => {
			const full = path.join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				const raw = fs.readlinkSync(full);
				const resolved = path.resolve(dir, raw);
				const unsafe = path.isAbsolute(raw) || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`));
				if (unsafe) (fs.existsSync(full) ? external : broken).push(relPath);
			} else if (entry.isDirectory()) {
				walk(full, relPath);
			}
		});
	};
	walk(root, '');
	return { external, broken };
}

/** Every `managed=` line from discoverRemoteScript(): links inside the webroot that resolve outside it. */
function parseManaged(stdout) {
	return [...new Set(stdout.split(/\r?\n/)
		.filter((l) => l.startsWith('managed='))
		.map((l) => l.slice('managed='.length).replace(/^\/+|\/+$/g, ''))
		.filter((p) => isSafeRelativePath(p)))].sort();
}

/** Every `nested=` line from discoverRemoteScript(), de-duplicated, without nested sites inside other nested sites. */
function parseNested(stdout) {
	return outermostDirs(stdout.split(/\r?\n/).filter((l) => l.startsWith('nested=')).map((l) => l.slice('nested='.length)));
}

/** Safe webroot-relative folders without surrounding slashes, de-duplicated, dropping any inside another one. */
function outermostDirs(dirs) {
	const all = [...new Set((dirs || [])
		.map((p) => String(p || '').trim().replace(/^\/+|\/+$/g, ''))
		.filter((p) => isSafeRelativePath(p)))];
	return all.filter((p) => !all.some((other) => other !== p && p.startsWith(`${other}/`))).sort();
}

/**
 * The site's public address from a stored link ("//example.com", or "//example.com/blog" for a WordPress installed
 * in a subfolder), used when WordPress itself does not report one. Empty without a domain.
 */
function linkBase(link, domain = link.domain) {
	if (!domain) return '';
	const dir = String(link.directory || '').replace(/^\/+|\/+$/g, '');
	return `//${domain}${dir ? `/${dir}` : ''}`;
}

const COMPARE_FORMAT = '--out-format=SP|%i|%l|%M|%n';

/** rsync prints %M as "YYYY/MM/DD-HH:MM:SS" in local time. Returns epoch seconds, or null. */
function parseRsyncTime(value) {
	const m = /^(\d{4})\/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
	if (!m) return null;
	return Math.round(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000);
}

/**
 * Parses dry-run output written with COMPARE_FORMAT into { op, type, size, mtime, path } items, where op is
 * 'create' (missing on the receiver), 'update' (differs) or 'delete' (only on the receiver). Directories and
 * attribute-only differences are dropped: the comparison is about file contents.
 */
function parseItemized(stdout) {
	const items = [];
	stdout.split(/\r?\n/).forEach((line) => {
		if (!line.startsWith('SP|')) return;
		const parts = line.split('|');
		if (parts.length < 5) return;
		const code = parts[1];
		const filePath = parts.slice(4).join('|');
		if (!filePath || filePath.endsWith('/')) return;
		if (code.startsWith('*deleting')) {
			items.push({ op: 'delete', type: 'file', size: null, mtime: null, path: filePath });
			return;
		}
		const [transfer, kind] = code;
		if (transfer === '.' || kind === 'd') return;
		items.push({
			op: code.slice(2).startsWith('+++') ? 'create' : 'update',
			type: kind === 'L' ? 'symlink' : 'file',
			size: Number(parts[2]),
			mtime: parseRsyncTime(parts[3]),
			path: filePath,
		});
	});
	return items;
}

/**
 * Merges a Local -> SpinupWP dry run with a SpinupWP -> Local dry run into one list of differing files. The two
 * passes complement each other: each reports the sender's size and mtime, so together they describe both sides.
 */
function mergeComparison(pushItems, pullItems) {
	const byPath = new Map();
	const entry = (p) => {
		if (!byPath.has(p)) byPath.set(p, { path: p, type: 'file', status: null, local: null, remote: null });
		return byPath.get(p);
	};
	pushItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'remote-only';
			return;
		}
		e.type = item.type;
		e.status = item.op === 'create' ? 'local-only' : 'changed';
		e.local = { size: item.size, mtime: item.mtime };
	});
	pullItems.forEach((item) => {
		const e = entry(item.path);
		if (item.op === 'delete') {
			e.status = e.status || 'local-only';
			return;
		}
		e.type = e.local ? e.type : item.type;
		e.status = item.op === 'create' ? 'remote-only' : 'changed';
		e.remote = { size: item.size, mtime: item.mtime };
	});
	return [...byPath.values()]
		.map((e) => {
			let newer = null;
			if (e.status === 'changed' && e.local && e.remote && e.local.mtime && e.remote.mtime) {
				newer = e.local.mtime > e.remote.mtime ? 'local' : e.remote.mtime > e.local.mtime ? 'remote' : 'same';
			}
			return { ...e, newer };
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Pushes Local sites to, and pulls them from, a linked SpinupWP site. */
class SyncService {
	constructor({ store, keys, workDir, getApi = () => null, resolveLink = async (link) => link, services, sendIPCEvent, logger }) {
		this._store = store;
		/** The connected account's SpinupWpApi (or null), used to purge SpinupWP's page and object caches after a push. */
		this._getApi = getApi;
		/** Optional hook that brings a stored link up to date before connecting. */
		this._resolveLink = resolveLink;
		this._keys = keys;
		this._workDir = workDir;
		this._siteData = services.siteData;
		this._siteDatabase = services.siteDatabase;
		this._siteProcessManager = services.siteProcessManager;
		this._wpCli = services.wpCli;
		this._send = sendIPCEvent;
		this._logger = logger;
		/** siteId -> 'push' | 'pull' | 'compare' */
		this._active = new Map();
		/** siteId -> Map(path -> status) from the latest comparison; selective transfers may only touch these. */
		this._compared = new Map();
	}

	activity(siteId) {
		return this._active.get(siteId) || null;
	}

	transportFor(link) {
		return new Transport({
			host: link.host,
			port: link.port,
			username: link.username,
			privateKeyPath: link.authType === 'password' ? null : this._keys.privateKeyPath,
			password: link.authType === 'password' ? link.password : null,
			workDir: this._workDir,
			logger: this._logger,
		});
	}

	/** Discovery hints from a stored link: its remote path once known, else the webroot, plus folders to leave alone. */
	static hintsFor(link) {
		return { remotePath: link.remotePath, webRoot: link.webRoot, excludeDirs: link.excludeDirs };
	}

	/**
	 * Connects, finds the webroot, and checks the server has what a push or pull needs. `excludeDirs` (webroot-relative
	 * folders to leave alone) are added to the nested sites every transfer excludes.
	 */
	async discoverRemote(transport, { remotePath, webRoot, excludeDirs } = {}) {
		const { code, stdout, stderr } = await transport.exec(discoverRemoteScript({ remotePath, webRoot }), { allowFailure: true });
		// ssh itself exits 255 when it cannot connect or log in; report that, not a missing WordPress.
		if (code === 255 && !/^webroot=/m.test(stdout)) throw new TransportError(describeSshFailure(code, stderr, transport), code, stderr);
		const info = parseKeyValues(stdout);
		if ((code === 3 || !info.webroot) && remotePath) {
			// Only this folder was searched (SpinupWP's webroot, or the path the user gave).
			throw new Error(`Connected, but found no WordPress (wp-config.php) in ${remotePath}. Check that WordPress is `
				+ 'installed in that folder on SpinupWP, or link the site again.');
		}
		if (code === 3 || !info.webroot) {
			throw new Error(
				`Connected, but could not find a WordPress install under ${info.home || 'the home directory'}. ` +
				'Set the remote path to the folder containing wp-config.php (on SpinupWP, /sites/<domain>/files).',
			);
		}
		if (code !== 0) {
			throw new Error(`Unexpected response from the server while locating WordPress (exit ${code}).`);
		}
		if (!info.private) {
			throw new Error('Connected, but found no writable folder outside the webroot for temporary database dumps.');
		}
		return this._withWp({
			remotePath: info.webroot,
			privateDir: info.private,
			wpCli: info.wpcli,
			hasPhp: info.php === 'yes',
			// Unknown (no php, or php -r printed nothing) counts as available: only a definite "no" changes how WP-CLI runs.
			procOpen: info.procopen !== 'no',
			wpPath: /^\//.test(info.wppath || '') ? info.wppath : null,
			wpIsPhp: info.wpphp === 'yes',
			hasRsync: info.rsync === 'yes',
			nested: outermostDirs([...parseNested(stdout), ...(Array.isArray(excludeDirs) ? excludeDirs : [])]),
			managed: parseManaged(stdout),
		});
	}

	/**
	 * Sets `remote.wp`, the command that runs WP-CLI on the server. Where proc_open is disabled (some shared hosts),
	 * WP-CLI cannot start mysqldump or mysql, so `wp db export/import/reset` fail with "Cannot do
	 * 'Process::run'"; running it through `php -d disable_functions=` lifts that for WP-CLI's own process. A `wp`
	 * that is not a PHP file (a shell wrapper, say) cannot be run that way and is used as is.
	 */
	_withWp(remote) {
		const php = remote.procOpen === false ? 'php -d disable_functions=' : 'php';
		let wp = null;
		if (remote.wpCli === 'wp') {
			wp = remote.procOpen === false && remote.wpPath && remote.wpIsPhp ? `${php} ${q(remote.wpPath)}` : 'wp';
		} else if (remote.wpCli === 'phar') {
			wp = `${php} ${q(`${remote.privateDir}/wp-cli.phar`)}`;
		}
		return { ...remote, wp, hasWpCli: Boolean(wp) };
	}

	/**
	 * Downloads the official WP-CLI build into the site's private folder when the server has no `wp` command, so
	 * database transfers still work without it. Returns the updated remote info (unchanged if WP-CLI is present).
	 */
	async ensureWpCli(transport, remote) {
		if (remote.hasWpCli || !remote.hasPhp) return remote;
		const dir = q(remote.privateDir);
		const url = q(WP_CLI_PHAR_URL);
		await transport.exec([
			`cd ${dir} &&`,
			`{ curl -fsSL ${url} -o wp-cli.phar.tmp 2>/dev/null || wget -q -O wp-cli.phar.tmp ${url}; } &&`,
			'php -d disable_functions= wp-cli.phar.tmp --info >/dev/null && mv wp-cli.phar.tmp wp-cli.phar; s=$?; rm -f wp-cli.phar.tmp; exit $s',
		].join(' '), { allowFailure: true });
		const check = await transport.exec(`[ -f ${q(`${remote.privateDir}/wp-cli.phar`)} ] && echo ok`, { allowFailure: true });
		return /ok/.test(check.stdout) ? this._withWp({ ...remote, wpCli: 'phar' }) : remote;
	}

	_message(siteId, label, progressText) {
		this._send('updateSiteMessage', siteId, {
			label,
			stripes: true,
			progressText,
			truncateProgressText: Boolean(progressText),
		});
	}

	/**
	 * Lists files that differ between Local and SpinupWP without transferring anything, like MagicSync's
	 * preview. Uses rsync's quick check (size + modification time) unless `checksum` is set.
	 */
	async compare(siteId, { checksum = false } = {}) {
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const stored = this._store.getLink(siteId);
		if (!stored) throw new Error('This site is not linked to SpinupWP yet.');
		if (this._active.has(siteId)) {
			throw new Error(`A SpinupWP ${this._active.get(siteId)} is already running for this site.`);
		}
		this._active.set(siteId, 'compare');
		let transport = null;
		try {
			const resolved = await this._resolveLink(stored);
			transport = this.transportFor(resolved);
			const remote = await this.discoverRemote(transport, SyncService.hintsFor(resolved));
			if (!remote.hasRsync) throw new Error('rsync was not found on the server, so files cannot be compared.');
			const args = [
				'--recursive',
				'--links',
				'--copy-unsafe-links',
				'--times',
				'--omit-dir-times',
				'--dry-run',
				'--delete',
				COMPARE_FORMAT,
				...(checksum ? ['--checksum'] : []),
			];
			const pushArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], remote, 'push')];
			const pullArgs = [...args, ...this._excludeArgs(site, ['push', 'pull'], remote, 'pull')];
			const pushOut = await transport.rsyncUp({ source: `${site.paths.webRoot}${path.sep}`, destination: `${remote.remotePath}/`, extraArgs: pushArgs });
			const pullOut = await transport.rsyncDown({ source: `${remote.remotePath}/`, destination: `${site.paths.webRoot}${path.sep}`, extraArgs: pullArgs });
			const entries = mergeComparison(parseItemized(pushOut), parseItemized(pullOut));
			this._compared.set(siteId, new Map(entries.map((e) => [e.path, e.status])));
			return { at: new Date().toISOString(), checksum, remotePath: remote.remotePath, entries };
		} finally {
			this._active.delete(siteId);
			if (transport) await transport.close();
		}
	}

	push(siteId, options = {}) {
		return this._run(siteId, 'push', options, (ctx) => this._push(ctx));
	}

	pull(siteId, options = {}) {
		return this._run(siteId, 'pull', options, (ctx) => this._pull(ctx));
	}

	/**
	 * Shared lifecycle for both directions, mirroring Local Connect: site status overlay, progress messages,
	 * completion/error banners, one transfer per site at a time.
	 */
	async _run(siteId, direction, options, body) {
		const labels = LABELS[direction];
		const opts = { ...DEFAULT_OPTIONS[direction], ...options };
		const site = this._siteData.getSite(siteId);
		if (!site) throw new Error('Local site not found.');
		const link = this._store.getLink(siteId);
		if (!link) throw new Error('This site is not linked to SpinupWP yet.');
		if (opts.fileList) {
			const compared = this._compared.get(siteId);
			if (!Array.isArray(opts.fileList) || !opts.fileList.length) throw new Error('Select at least one file.');
			if (!compared || opts.fileList.some((p) => !compared.has(p) || !isSafeRelativePath(p))) {
				throw new Error('The file list is out of date. Compare again, then choose files.');
			}
			// Files that exist only on the receiving side are deleted there rather than transferred.
			const onlyOnReceiver = direction === 'push' ? 'remote-only' : 'local-only';
			opts.selection = {
				transfer: opts.fileList.filter((p) => compared.get(p) !== onlyOnReceiver),
				remove: opts.fileList.filter((p) => compared.get(p) === onlyOnReceiver),
			};
			opts.files = true;
			opts.database = false;
		}
		if (!opts.files && !opts.database) throw new Error(`Choose files, database, or both to ${labels.verb}.`);
		if (this._active.has(siteId)) {
			throw new Error(`A SpinupWP ${this._active.get(siteId)} is already running for this site.`);
		}

		this._active.set(siteId, direction);
		this._send('updateSiteStatus', siteId, labels.status);
		const startedAt = Date.now();
		const warnings = [];
		const destination = link.label || link.domain || link.host;

		let transport = null;
		try {
			this._message(siteId, 'Connecting to SpinupWP');
			const resolved = await this._resolveLink(link);
			transport = this.transportFor(resolved);
			let remote = await this.discoverRemote(transport, SyncService.hintsFor(resolved));
			if (opts.database && !remote.hasWpCli && remote.hasPhp) {
				this._message(siteId, 'Installing WP-CLI on the server');
				remote = await this.ensureWpCli(transport, remote);
			}
			if (opts.database && !remote.hasWpCli) {
				throw new Error(`WP-CLI was not found on the server, so the database cannot be ${labels.done.split(' ')[0]}.`);
			}
			if (opts.files && !remote.hasRsync) {
				throw new Error(`rsync was not found on the server, so files cannot be ${labels.done.split(' ')[0]}.`);
			}

			const notes = [];
			await body({ site, link, opts, transport, remote, warnings, notes });

			const summary = {
				at: new Date().toISOString(),
				files: opts.files,
				database: opts.database,
				selectedFiles: opts.fileList ? opts.fileList.length : undefined,
				seconds: Math.round((Date.now() - startedAt) / 1000),
			};
			this._store.updateLink(siteId, {
				[direction === 'push' ? 'lastPush' : 'lastPull']: summary,
				remotePath: remote.remotePath,
				privateDir: remote.privateDir,
				nested: remote.nested,
				managed: remote.managed,
			});

			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `spinupwp-site-${direction}ed`,
				title: `${direction === 'push' ? 'Push' : 'Pull'} complete!`,
				message: `${site.name} has been ${labels.done} SpinupWP (${destination}).${[...warnings, ...notes].map((m) => ` ${m}`).join('')}`,
				variant: warnings.length ? 'warning' : 'success',
			});
			if (direction === 'pull') this._send('refreshSiteVersions');
			return { ok: true, summary, warnings };
		} catch (e) {
			this._logger.error(`SpinupWP ${direction} failed: ${e.message}`, { stack: e.stack, stderr: e.stderr });
			this._send('clearConnectBanners', siteId);
			this._send('showSiteBanner', {
				siteID: siteId,
				id: `spinupwp-${labels.gerund}-error`,
				title: `Uh-oh! We ran into an issue when ${labels.gerund} ${labels.preposition} SpinupWP.`,
				message: e.message,
				variant: 'error',
			});
			throw e;
		} finally {
			this._active.delete(siteId);
			this._compared.delete(siteId);
			if (transport) await transport.close();
			const status = this._siteProcessManager ? this._siteProcessManager.getSiteStatus(site) : 'running';
			this._send('updateSiteStatus', siteId, status === labels.status ? 'running' : status);
			this._send('getAttention');
		}
	}

	async _ensureLocalSiteRunning(site, direction) {
		if (this._siteProcessManager && this._siteProcessManager.getSiteStatus(site) !== 'running') {
			this._message(site.id, 'Starting the Local site to access its database');
			await this._siteProcessManager.start(site);
			this._send('updateSiteStatus', site.id, LABELS[direction].status);
		}
	}

	/** Excludes for a transfer in the `side` direction ('push' or 'pull'), plus the ignore files of `directions`. */
	_excludeArgs(site, directions, remote, side) {
		const args = SYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
		// Other sites served from inside this webroot (other websites and subdomains of the account, separate WordPress
		// installs) are never transferred or deleted.
		(remote.nested || []).forEach((p) => args.push(`--exclude=/${p}/`));
		// Server-managed links are never replaced by a push; a pull brings their contents down as real files.
		if (side === 'push') (remote.managed || []).forEach((p) => args.push(`--exclude=/${p}`));
		const links = findExternalLinks(site.paths.webRoot);
		if (links.broken.length) this._logger.warn(`Skipping broken symlinks in ${site.name}: ${links.broken.join(', ')}`);
		(side === 'pull' ? [...links.external, ...links.broken] : links.broken).forEach((p) => args.push(`--exclude=/${p}`));
		args.push(...SYNC_PROTECT);
		directions.forEach((direction) => {
			const ignoreFile = path.join(site.paths.webRoot, IGNORE_FILES[direction]);
			if (fs.existsSync(ignoreFile)) args.push(`--exclude-from=${toPosixPath(ignoreFile)}`);
		});
		return args;
	}

	/**
	 * rsync flags for a transfer. With a file list (selective sync) only those paths move. Deletions for a
	 * selection are done separately (see _push/_pull): rsync 3.1's --delete-missing-args aborts when a listed
	 * file's parent folder is also missing on the sender. Returns a cleanup function for the temporary list file.
	 */
	_fileSyncArgs(site, direction, remote, { deleteExtraneous, fileList, backupDir }) {
		// --copy-unsafe-links: a symlink pointing outside the site (a theme or plugin developed in another folder and
		// linked into wp-content) is sent as the files it points to; the other side has no such folder. Links within the
		// site stay links.
		// No --perms: existing files and folders keep the receiver's permissions, and --chmod alone sets them for new
		// ones. Where a server owns some folders itself, forcing permissions fails, and a newer server rsync (SpinupWP
		// runs 3.2.7) reports that with a message Local's bundled rsync 3.1.3 cannot decode ("unexpected tag"), which
		// aborts the whole transfer.
		const args = [
			'--links',
			'--copy-unsafe-links',
			'--times',
			'--omit-dir-times',
			'--compress',
			'--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r',
			'--verbose',
			'--out-format=Changed:%n',
		];
		let listFile = null;
		if (fileList) {
			listFile = path.join(os.tmpdir(), `spinupwp-files-${site.id}-${crypto.randomBytes(6).toString('hex')}.txt`);
			fs.writeFileSync(listFile, fileList.join('\0'));
			args.push(`--files-from=${toPosixPath(listFile)}`, '--from0');
		} else {
			args.push('--recursive');
			if (deleteExtraneous) args.push('--delete');
		}
		args.push(...this._excludeArgs(site, [direction], remote, direction));
		// Files the transfer replaces or deletes are moved here instead of being lost (a pull into Local by mistake).
		if (backupDir) args.push('--backup', `--backup-dir=${toPosixPath(backupDir)}`);
		return { args, cleanup: () => listFile && fs.rmSync(listFile, { force: true }) };
	}

	_fileProgress(siteId, label) {
		let lastUpdate = 0;
		return (file) => {
			const now = Date.now();
			if (now - lastUpdate < 150) return;
			lastUpdate = now;
			this._message(siteId, label, file);
		};
	}

	async _rsyncFiles(site, direction, transport, remote, { deleteExtraneous, fileList, backupDir }) {
		const { args, cleanup } = this._fileSyncArgs(site, direction, remote, { deleteExtraneous, fileList, backupDir });
		const localRoot = `${site.paths.webRoot}${path.sep}`;
		const remoteRoot = `${remote.remotePath}/`;
		try {
			if (direction === 'push') {
				await transport.rsyncUp({ source: localRoot, destination: remoteRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Uploading files') });
			} else {
				await transport.rsyncDown({ source: remoteRoot, destination: localRoot, extraArgs: args, onFile: this._fileProgress(site.id, 'Downloading files') });
			}
		} finally {
			cleanup();
		}
	}

	_tempName(site, kind) {
		const token = crypto.randomBytes(6).toString('hex');
		return { token, local: path.join(os.tmpdir(), `spinupwp-${kind}-${site.id}-${token}.sql`) };
	}

	async _getLocalTablePrefix(site) {
		try {
			return await this._siteDatabase.getTablePrefix(site);
		} catch (e) {
			this._logger.warn(`Could not read the local table prefix: ${e.message}`);
			return null;
		}
	}

	// ---------------------------------------------------------------- push

	async _push({ site, link, opts, transport, remote, warnings }) {
		// SpinupWP's API can't start a backup (site backups run on the schedule set in SpinupWP, if any). The database is
		// saved on the server (local-backup-before-push.sql in the site's private folder) before an import replaces it.
		if (opts.files && opts.selection) {
			const { transfer, remove } = opts.selection;
			this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) to SpinupWP`);
			if (transfer.length) await this._rsyncFiles(site, 'push', transport, remote, { fileList: transfer });
			// The comparison lists files behind server-managed links (pulled as real files), but `rm` through such a link
			// would delete them where it points. Those and nested sites are left alone.
			const keep = remove.filter((p) => isUnderAny(p, [...(remote.managed || []), ...(remote.nested || [])]));
			const removable = remove.filter((p) => !keep.includes(p));
			if (keep.length) warnings.push(`${keep.length} selected file(s) behind a server-managed link or in another site's folder were not deleted on SpinupWP.`);
			for (let i = 0; i < removable.length; i += 200) {
				await transport.exec(`cd ${q(remote.remotePath)} && rm -f -- ${removable.slice(i, i + 200).map(q).join(' ')}`);
			}
		} else if (opts.files) {
			this._message(site.id, 'Uploading files to SpinupWP');
			await this._rsyncFiles(site, 'push', transport, remote, { deleteExtraneous: opts.deleteRemote });
		}

		if (opts.database) {
			await this._pushDatabase(site, link, transport, remote, warnings);
		}

		if (opts.purgeCache) {
			this._message(site.id, 'Clearing caches on SpinupWP');
			await this._clearSpinupWPCache(link, transport, remote, warnings);
		}
	}

	/**
	 * Flushes WordPress's object cache with WP-CLI, then purges SpinupWP's Nginx page cache and Redis object cache
	 * through the API. Page-cache files belong to the web server, so the site user can't delete them: without the API
	 * (a manual link, or the account disconnected) the SpinupWP plugin's own WP-CLI command purges them, if the site
	 * has the plugin. None of this is fatal.
	 */
	async _clearSpinupWPCache(link, transport, remote, warnings) {
		const api = link.mode === 'account' && link.spinupwpSiteId ? this._getApi() : null;
		let pluginPurged = false;
		if (remote.wp) {
			const out = await transport.exec(`cd ${q(remote.remotePath)} && ${wpCommand(remote)} cache flush >/dev/null 2>&1; `
				+ (api ? 'true' : `if ${remote.wp} spinupwp cache purge-site --skip-themes >/dev/null 2>&1; then echo page=purged; fi`), { allowFailure: true });
			pluginPurged = /page=purged/.test(out.stdout || '');
		}
		if (!api) {
			if (!pluginPurged) {
				warnings.push(link.mode === 'account'
					? 'The SpinupWP account is disconnected, so SpinupWP\'s page cache was not purged; purge it in SpinupWP if pages still look old.'
					: 'SpinupWP\'s page cache could not be purged (the site has no SpinupWP plugin); purge it in SpinupWP if pages still look old.');
			}
			return;
		}
		const results = await Promise.allSettled([
			api.purgePageCache(link.spinupwpSiteId).then((id) => api.waitForEvent(id, { timeoutMs: 30 * 1000 })),
			api.purgeObjectCache(link.spinupwpSiteId).then((id) => api.waitForEvent(id, { timeoutMs: 30 * 1000 })),
		]);
		const [page, object] = results;
		if (page.status === 'rejected') warnings.push(`SpinupWP's page cache was not purged: ${page.reason.message}`);
		// A site without Redis object caching answers with an error; WP-CLI already flushed whatever cache WordPress uses.
		if (object.status === 'rejected') this._logger.warn(`SpinupWP object cache purge: ${object.reason.message}`);
	}

	async _pushDatabase(site, link, transport, remote, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		const WP = wpCommand(remote);
		await this._ensureLocalSiteRunning(site, 'push');

		this._message(site.id, 'Exporting the Local database');
		const { token, local: localDump } = this._tempName(site, 'push');
		const remoteDump = `${remote.privateDir}/local-push-${token}.sql`;
		const remoteBackup = `${remote.privateDir}/${REMOTE_BACKUP_NAME}`;

		try {
			await this._siteDatabase.dump(site, localDump);
			await normalizeDumpForImport(localDump);

			this._message(site.id, 'Backing up the SpinupWP database');
			const state = parseKeyValues((await transport.exec(
				`${cd} && umask 077 && ${tableListSnippet(WP)} && ` +
				`${WP} db export ${q(remoteBackup)} ${PREFIX_TABLES_ARG} --no-tablespaces=true >/dev/null && ` +
				'echo "table_prefix=$p" && echo "tables=$(printf \'%s\' "$a" | tr \'\\n\' \' \')" && ' +
				`echo "home=$(${WP} option get home 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || linkBase(link);
			const localPrefix = await this._getLocalTablePrefix(site);

			// One database can hold several WordPress sites (a parent website and a subfolder install, say), told apart by
			// their table prefixes. `wp db reset` would drop the whole database, so then only this site's tables are
			// replaced, and a Local prefix that matches another site's tables stops the push before anything changes.
			const tables = String(state.tables || '').split(/\s+/).filter(Boolean);
			const ownTables = remotePrefix ? tables.filter((t) => t.startsWith(remotePrefix)) : [];
			const otherTables = remotePrefix ? tables.filter((t) => !t.startsWith(remotePrefix)) : [];
			const shared = otherTables.length > 0;
			if (shared) {
				const clash = localPrefix ? otherTables.filter((t) => t.startsWith(localPrefix)) : otherTables;
				if (!localPrefix || clash.length) {
					throw new Error(`The SpinupWP database also holds tables of another site (${otherTables.slice(0, 3).join(', ')}${otherTables.length > 3 ? ', …' : ''}), `
						+ `and ${localPrefix ? `this Local site's table prefix (${localPrefix}) would overwrite ${clash.slice(0, 3).join(', ')}` : 'the Local table prefix could not be read'}. `
						+ `Change the Local site's table prefix to ${remotePrefix} (or push files only); the database was not changed.`);
				}
				if (ownTables.some((t) => !SAFE_TABLE_NAME.test(t))) {
					throw new Error('The SpinupWP database is shared with another site and has table names the add-on can\'t drop safely; the database was not changed.');
				}
			}
			const dropOwn = ownTables.length
				? `${WP} db query ${q(`DROP TABLE IF EXISTS ${ownTables.map((t) => `\`${t}\``).join(', ')}`)} && `
				: '';
			const clearForImport = shared ? dropOwn : `${WP} db reset --yes && `;

			this._message(site.id, 'Uploading the database');
			await transport.rsyncUp({ source: localDump, destination: remoteDump, extraArgs: ['--compress', '--times'] });

			this._message(site.id, 'Importing the database on SpinupWP');
			try {
				await transport.exec(`${cd} && ${clearForImport}${WP} db import ${q(remoteDump)}`);
			} catch (importError) {
				this._message(site.id, 'Import failed, restoring the previous SpinupWP database');
				// The backup holds only this site's tables (each dropped and recreated by the import) when others share the database.
				const restore = await transport.exec(`${cd} && ${shared ? '' : `${WP} db reset --yes && `}${WP} db import ${q(remoteBackup)}`, { allowFailure: true });
				if (restore.code !== 0) {
					throw new Error(`Database import failed, and restoring the previous database also failed. The backup is on the server at ${remoteBackup}. ${importError.message}`);
				}
				throw new Error(`Database import failed and the previous database was restored. ${importError.message}`);
			}

			if (localPrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the remote table prefix to match Local');
				await transport.exec(`${cd} && ${WP} config set table_prefix ${q(localPrefix)}`);
			}

			if (!site.domain || !remoteHome) {
				warnings.push('Could not determine the SpinupWP URL, so Local URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing Local URLs with the SpinupWP URL');
			// In a shared database --all-tables would also rewrite the other sites' tables.
			const tableScope = shared ? '--all-tables-with-prefix' : '--all-tables';
			for (const [from, to] of urlReplacements([`//${site.domain}`], remoteHome)) {
				await transport.exec(`${cd} && ${WP} search-replace ${q(from)} ${q(to)} ${tableScope} --precise --skip-columns=guid --report-changed-only`);
			}
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}

	// ---------------------------------------------------------------- pull

	/**
	 * A new folder for the Local files this pull replaces or deletes, beside the webroot (app/spinupwp-backups/<time>).
	 * Older ones beyond FILE_BACKUPS_KEPT are removed.
	 */
	_newFileBackupDir(site) {
		const parent = path.join(path.dirname(path.resolve(site.paths.webRoot)), FILE_BACKUP_FOLDER);
		fs.mkdirSync(parent, { recursive: true });
		const existing = fs.readdirSync(parent).filter((d) => /^pull-/.test(d)).sort();
		existing.slice(0, Math.max(0, existing.length - (FILE_BACKUPS_KEPT - 1))).forEach((d) => {
			fs.rmSync(path.join(parent, d), { recursive: true, force: true });
		});
		return path.join(parent, `pull-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	}

	/** Reports where a pull saved the Local files it replaced, or removes the folder if it saved none. */
	_finishFileBackup(site, backupDir, notes) {
		if (!fs.existsSync(backupDir)) return;
		if (!fs.readdirSync(backupDir).length) {
			fs.rmSync(backupDir, { recursive: true, force: true });
			return;
		}
		const shown = path.relative(path.dirname(path.dirname(path.resolve(site.paths.webRoot))), backupDir);
		notes.push(`Local files it replaced or deleted were saved in ${shown}.`);
	}

	async _pull({ site, link, opts, transport, remote, warnings, notes = [] }) {
		if (opts.files) {
			const backupDir = this._newFileBackupDir(site);
			try {
				if (opts.selection) {
					const { transfer, remove } = opts.selection;
					this._message(site.id, `Syncing ${opts.fileList.length} selected file(s) from SpinupWP`);
					if (transfer.length) await this._rsyncFiles(site, 'pull', transport, remote, { fileList: transfer, backupDir });
					const root = path.resolve(site.paths.webRoot);
					// Never through a link to a folder outside the site (a theme developed elsewhere): a pull doesn't write there.
					const links = findExternalLinks(root);
					const outside = [...links.external, ...links.broken];
					remove.forEach((p) => {
						const target = path.resolve(root, p);
						if (isUnderAny(p, outside)) return;
						if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) return;
						const saved = path.join(backupDir, path.relative(root, target));
						fs.mkdirSync(path.dirname(saved), { recursive: true });
						fs.renameSync(target, saved);
					});
				} else {
					this._message(site.id, 'Downloading files from SpinupWP');
					fs.mkdirSync(site.paths.webRoot, { recursive: true });
					await this._rsyncFiles(site, 'pull', transport, remote, { deleteExtraneous: opts.deleteLocal, backupDir });
				}
			} finally {
				this._finishFileBackup(site, backupDir, notes);
			}
		}

		if (opts.database) {
			// WP-CLI needs WordPress core to import; stop before touching the database rather than half-way through.
			const core = ['wp-load.php', 'wp-settings.php', path.join('wp-includes', 'version.php')];
			const missing = core.filter((f) => !fs.existsSync(path.join(site.paths.webRoot, f)));
			if (missing.length) {
				throw new Error(`WordPress core is missing from the Local site (${missing.join(', ')}), so the database was not changed. `
					+ 'Reinstall core (for example with "wp core download --skip-content" in Local\'s site shell), then pull again.');
			}
			await this._pullDatabase(site, link, transport, remote, opts, warnings);
		}
	}

	/** Runs WP-CLI against the Local site through Local's own WP-CLI service (right PHP, MySQL socket, config). */
	async _localWp(site, args) {
		const out = await this._wpCli.run(site, args);
		return String(out === null || out === undefined ? '' : (out.stdout !== undefined ? out.stdout : out)).trim();
	}

	async _pullDatabase(site, link, transport, remote, opts, warnings) {
		const cd = `cd ${q(remote.remotePath)}`;
		const WP = wpCommand(remote);
		await this._ensureLocalSiteRunning(site, 'pull');

		const { token, local: localDump } = this._tempName(site, 'pull');
		const remoteDump = `${remote.privateDir}/local-pull-${token}.sql`;
		const localBackup = path.join(site.paths.sql || path.dirname(site.paths.webRoot), LOCAL_BACKUP_NAME);
		// Local's WP-CLI service runs through the Windows shell there, so quote paths ourselves.
		const cliPath = (p) => (process.platform === 'win32' ? `"${p}"` : p);

		try {
			this._message(site.id, 'Exporting the SpinupWP database');
			const state = parseKeyValues((await transport.exec(
				// Only this site's tables: another site sharing the database never ends up on this computer.
				`${cd} && umask 077 && ${tableListSnippet(WP)} && ` +
				`${WP} db export ${q(remoteDump)} ${PREFIX_TABLES_ARG} --no-tablespaces=true --single-transaction --quick --lock-tables=false >/dev/null && ` +
				'echo "table_prefix=$p" && ' +
				`echo "home=$(${WP} option get home 2>/dev/null)" && ` +
				`echo "wp_version=$(${WP} core version 2>/dev/null)"`,
			)).stdout);
			const remotePrefix = state.table_prefix || null;
			const remoteHome = state.home || linkBase(link);
			// Each side keeps its own core when the server manages it, so the database may come from a newer WordPress.
			const localVersion = await this._localWp(site, ['core', 'version']).catch(() => '');
			if (state.wp_version && localVersion && state.wp_version !== localVersion) {
				warnings.push(`SpinupWP runs WordPress ${state.wp_version} and this Local site has ${localVersion}; update Local's WordPress to match.`);
			}

			this._message(site.id, 'Downloading the database');
			await transport.rsyncDown({ source: remoteDump, destination: localDump, extraArgs: ['--compress', '--times'] });
			await normalizeDumpForImport(localDump);

			const localHome = (await this._localWp(site, ['option', 'get', 'home']).catch(() => '')) || `http://${site.domain}`;

			if (opts.backupLocal) {
				this._message(site.id, 'Backing up the Local database');
				fs.mkdirSync(path.dirname(localBackup), { recursive: true });
				await this._siteDatabase.dump(site, localBackup);
			}

			this._message(site.id, 'Importing the database into Local');
			try {
				await this._localWp(site, ['db', 'reset', '--yes']);
				await this._localWp(site, ['db', 'import', cliPath(localDump)]);
			} catch (importError) {
				if (opts.backupLocal) {
					this._message(site.id, 'Import failed, restoring the previous Local database');
					try {
						await this._localWp(site, ['db', 'reset', '--yes']);
						await this._localWp(site, ['db', 'import', cliPath(localBackup)]);
					} catch (restoreError) {
						throw new Error(`Database import failed, and restoring the previous Local database also failed. The backup is at ${localBackup}. ${importError.message}`);
					}
					throw new Error(`Database import failed and the previous Local database was restored. ${importError.message}`);
				}
				throw new Error(`Database import failed. ${importError.message}`);
			}

			const localPrefix = await this._getLocalTablePrefix(site);
			if (remotePrefix && localPrefix !== remotePrefix) {
				this._message(site.id, 'Updating the Local table prefix to match SpinupWP');
				await this._localWp(site, ['config', 'set', 'table_prefix', remotePrefix]);
			}

			if (!remoteHome) {
				warnings.push('Could not determine the SpinupWP URL, so its URLs were not replaced.');
				return;
			}
			this._message(site.id, 'Replacing SpinupWP URLs with the Local URL');
			// The site's other addresses (its other domains and the www/non-www twin) often linger in content built before
			// the primary domain went live.
			const fromBases = [remoteHome, ...(link.altDomains || []).filter(Boolean).map((d) => linkBase(link, d))];
			for (const [from, to] of urlReplacements(fromBases, localHome)) {
				await this._localWp(site, ['search-replace', from, to, '--all-tables', '--precise', '--skip-columns=guid', '--report-changed-only']);
			}
			await this._localWp(site, ['cache', 'flush']).catch(() => {});
		} finally {
			fs.rmSync(localDump, { force: true });
			fs.rmSync(`${localDump}.tmp`, { force: true });
			await transport.exec(`rm -f ${q(remoteDump)}`, { allowFailure: true }).catch(() => {});
		}
	}
}

module.exports = {
	SyncService,
	DEFAULT_OPTIONS,
	discoverRemoteScript,
	parseNested,
	parseManaged,
	findExternalLinks,
	parseKeyValues,
	normalizeDumpForImport,
	urlReplacements,
	parseItemized,
	mergeComparison,
};
