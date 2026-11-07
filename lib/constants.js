'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'spinupwpConnect:getState',
	/** siteId -> remote domain for every linked site, for the sites-list marks. */
	LINKED_SITES: 'spinupwpConnect:linkedSites',
	CONNECT_ACCOUNT: 'spinupwpConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'spinupwpConnect:disconnectAccount',
	LIST_SITES: 'spinupwpConnect:listSites',
	LINK_ACCOUNT_SITE: 'spinupwpConnect:linkAccountSite',
	LINK_MANUAL: 'spinupwpConnect:linkManual',
	UNLINK_SITE: 'spinupwpConnect:unlinkSite',
	TEST_CONNECTION: 'spinupwpConnect:testConnection',
	PUSH: 'spinupwpConnect:push',
	PULL: 'spinupwpConnect:pull',
	COMPARE: 'spinupwpConnect:compare',
	NEW_SITE_LOCATION: 'spinupwpConnect:newSiteLocation',
	PULL_NEW_SITE: 'spinupwpConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'spinupwpConnect:linkProgress',
	GET_PUBLIC_KEY: 'spinupwpConnect:getPublicKey',
	CHECK_UPDATE: 'spinupwpConnect:checkUpdate',
	INSTALL_UPDATE: 'spinupwpConnect:installUpdate',
	RESTART_LOCAL: 'spinupwpConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'spinupwpConnect:stateChanged',
};

/** SpinupWP's API (beta). Paths start with /v1. */
const SPINUPWP_API_BASE = 'https://api.spinupwp.app';

/** Servers listen for SSH on port 22 unless the API says otherwise (each server reports its own `ssh_port`). */
const SPINUPWP_SSH_PORT = 22;

/**
 * A site user's home folder is /sites/<domain>, and the site's files are in its `files` folder (the API's
 * `public_folder` is relative to it). The private folder for dumps goes in the home folder, outside the webroot.
 */
const spinupwpWebRoot = (domain, publicFolder) => {
	const sub = String(publicFolder || '/').replace(/^\/+|\/+$/g, '');
	return `/sites/${domain}/files${sub ? `/${sub}` : ''}`;
};

/** Where the official WP-CLI build is downloaded from when a server has no `wp` command. */
const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own server files: SpinupWP keeps wp-config.php (its database settings and salts) and the SpinupWP plugin's
 * caching drop-ins, and Local never receives them, since they would break the local site.
 */
const SYNC_EXCLUDES = [
	// Server-specific config
	'/wp-config.php',
	'/.htaccess',
	'/.user.ini',
	'/php.ini',
	'/wp-cli.yml',
	// Server-specific state: Jetpack's firewall rules hold absolute server paths; upgrade/ is WordPress scratch space
	'wp-content/jetpack-waf/',
	'wp-content/upgrade/',
	'wp-content/upgrade-temp-backup/',
	// Logs: SpinupWP links wp-content/debug.log to the site's logs folder, outside the webroot
	'wp-content/debug.log',
	// Caching drop-ins (the SpinupWP plugin's Redis object cache and page-cache helper) and cache output
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	// Site backups made by migration plugins: often gigabytes, and never wanted on the other side
	'wp-content/ai1wm-backups/',
	'wp-content/updraft/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps and Local helpers
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
	'.hostinger-push-ignore',
	'.hostinger-pull-ignore',
	'.pressable-push-ignore',
	'.pressable-pull-ignore',
	'.spinupwp-push-ignore',
	'.spinupwp-pull-ignore',
];

/**
 * rsync filter rules added after the excludes. Must-use plugins that exist only on the receiving side are never
 * deleted: hosts install their own there, and a push from a Local site without them must not remove them.
 */
const SYNC_PROTECT = [
	'--filter=P wp-content/mu-plugins/*',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.spinupwp-push-ignore',
	pull: '.spinupwp-pull-ignore',
};

module.exports = {
	IPC,
	SPINUPWP_API_BASE,
	SPINUPWP_SSH_PORT,
	spinupwpWebRoot,
	WP_CLI_PHAR_URL,
	SYNC_EXCLUDES,
	SYNC_PROTECT,
	IGNORE_FILES,
};
