# ConnectLocal for SpinupWP

A [Local](https://localwp.com) add-on that connects Local to WordPress sites on servers managed by [SpinupWP](https://spinupwp.com). It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files, database, or both to a SpinupWP site;
- **pull** them back into an existing Local site;
- **pull a SpinupWP site into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

Files move with rsync over SSH and the database with WP-CLI, the same tools Local Connect uses for WP Engine. The [SpinupWP API](https://api.spinupwp.com/) handles what it can around the transfer: listing your sites and servers, finding each site's server, SSH port and site user, and purging the page and object caches after a push.

| Step | WP Engine (built in) | ConnectLocal for SpinupWP |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | A SpinupWP API token (personal or team). The API can't add SSH keys to an account, so you add Local's key once in SpinupWP (**Account Settings → SSH Keys**) and attach it to each site's site user. If a site user uses password authentication, type its password when linking; it is stored encrypted. |
| Finding the site | CAPI install list | `GET /v1/sites` and `GET /v1/servers`, grouped by server. |
| SSH login | From CAPI | The server's `ip_address` and `ssh_port`, as the site's `site_user`, which can only reach that site's folder. |
| Backup | CAPI backup before push | The API can't start a backup. The add-on saves the current database on the server before replacing it; SpinupWP's scheduled site backups, if turned on, are there too. |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries and flags, for the whole webroot (`/sites/<domain>/files`). `wp-config.php` and the caching drop-ins stay put on both sides. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same. Plus collation fixes between MySQL 8 and MariaDB, and automatic restore if an import fails. |
| Pull | rsync down, export remote DB, import, `search-replace //remote //local` | Same. It also replaces the site's additional domains, its SpinupWP preview address (`*.spinupwp.site`) and the `www`/non-`www` twin. |
| Cache | Purge CDN/object/page cache | `wp cache flush` over SSH, then `POST /v1/sites/{id}/page-cache/purge` and `/object-cache/purge`. Without the API, the SpinupWP plugin's `wp spinupwp cache purge-site`. |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from SpinupWP". It checks the connection first, creates the site with Local's `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |

## Requirements

- Local 6 or newer. Developed against **Local 10.2 on macOS**.
- A WordPress site on a SpinupWP server. SpinupWP servers have WP-CLI; rsync is part of Ubuntu.
- Local's SSH key added to your SpinupWP account under **Account Settings → SSH Keys**, then attached to the site's **site user** with **Add SSH Key** ([SpinupWP's guide](https://spinupwp.com/doc/how-to-ssh-keys/)). Or a site user set to password authentication.
- A SpinupWP **API token** (recommended): **My Account → API Tokens**, or **Team Settings → API Tokens** for a team token (team owners and admins). A team token only sees that team's servers and sites.
  - Without one, you can still link a site with its server's IP address and its site user.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

This add-on is separate from ConnectLocal for Cloudways, Bluehost, Kinsta, Hostinger and Pressable, and can be installed next to them: package names, IPC channels, CSS classes, storage folders and ignore files are all distinct.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. In SpinupWP, add Local's SSH key under **Account Settings → SSH Keys** (the panel shows the key and a Copy button), then edit the site's **site user** and attach it with **Add SSH Key**.
2. Open a site in Local and go to **Tools → SpinupWP**. Connect in one of two ways:
   - **SpinupWP API (recommended):** paste an API token, pick a site (grouped by server) and click **Link**. Sites that can't be linked, such as disabled or non-WordPress ones, are shown greyed out with the reason. The add-on then:
     - reads the site and its server from the API;
     - logs in to the server's IP address on its SSH port as the site user, with Local's SSH key or with the site user's password if you typed one;
     - checks that WordPress is in the site's folder, `/sites/<domain>/files` (plus the site's public folder, if set).
   - **SSH details:** enter the server's IP address, the SSH port (22 is filled in) and the site user. Add the site's domain so the add-on looks in `/sites/<domain>/files`. Use Local's key, or the site user's password.
3. Push or pull from the panel's **Push to SpinupWP** / **Pull from SpinupWP** tabs. Once the site is linked, you can also use the **SpinupWP: Pull / Push** buttons in the site header.
   - Push options: Files and/or Database; delete files on SpinupWP that aren't in Local (on by default, like WP Engine); clear SpinupWP's caches afterwards.
   - Pull options: Files and/or Database; back up the Local database first; delete Local files that aren't on SpinupWP (on by default).
   - Every pull moves the Local files it replaces or deletes into `app/spinupwp-backups/pull-<time>/` instead of discarding them. The last 3 are kept.

Once a site is linked, a small SpinupWP logo appears next to its name in Local's sites list, and **Tools → SpinupWP** shows a green check. Other ConnectLocal add-ons put their logos in the same spot, so a site linked to more than one host shows each logo side by side.

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### Pull a SpinupWP site into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from SpinupWP**.
2. Pick the site, or enter SSH details. Name the Local site; it defaults to the site's domain.
3. Click **Create site & pull**. The connection is checked **first**, so a wrong login never leaves an empty site behind.

### Compare & sync files (selective sync)

Go to **Tools → SpinupWP → Compare & sync files** and click **Compare with SpinupWP**. Nothing changes until you choose files. Differing files are listed under **Different on each side**, **Only in Local** and **Only on SpinupWP**. Tick files, then click **Push selected** or **Pull selected**. A ticked file that exists only on the receiving side is deleted there, except behind a server-managed link. The database is never touched.

### What a database push does

1. Exports the Local database and, for a server running MariaDB, rewrites MySQL 8 `utf8mb4_0900_*` collations to ones MariaDB accepts.
2. On SpinupWP, saves the current database to `local-backup-before-push.sql` in a private folder, `~/.spinupwp-connect/files-<checksum>` in the site user's home, `/sites/<domain>` (mode 700, outside the webroot). It also reads the current `home` URL and `table_prefix`.
3. Uploads the dump to that folder, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
4. Sets `table_prefix` in SpinupWP's `wp-config.php` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (`--precise`, `guid` skipped) from `//site.local` to the SpinupWP URL, including the JSON-escaped form, plus `http://` → `https://`.

### What a database pull does

1. On SpinupWP, exports the database with `--single-transaction` (the live site isn't locked), downloads it and deletes the export.
2. Makes the dump importable by Local's MySQL. For a MariaDB server, it removes MariaDB's "sandbox mode" line and rewrites `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Imports through Local's own WP-CLI service. If the import fails, it restores the backup.
5. Matches Local's `table_prefix` to SpinupWP's, then replaces the SpinupWP URL, the site's additional domains, its preview address and the `www`/non-`www` twin with the Local URL.

### Backups

The add-on doesn't make a SpinupWP backup before a push: SpinupWP's API can't start one. If the site has backups turned on in SpinupWP, restore one from the site's **Backups** page. On top of that, every database push keeps the previous database as `local-backup-before-push.sql` in the site's private folder (see above), and every pull keeps the Local files it replaced.

### Caches

After a push (option on by default), the add-on runs `wp cache flush` over SSH. For a site linked through the API, it then purges SpinupWP's Nginx page cache and Redis object cache with `POST /v1/sites/{id}/page-cache/purge` and `/object-cache/purge`, and waits up to 30 seconds for each to finish. The page-cache files belong to the web server, so the site user can't delete them itself; for a manual link the add-on asks the SpinupWP plugin instead (`wp spinupwp cache purge-site`). A failed purge is reported as a warning; the push itself has already succeeded.

### What is never transferred

These are excluded in both directions, and excluded paths are also protected from `--delete`:

- Server config: `wp-config.php`, `.htaccess`, `.user.ini`, `php.ini`, `wp-cli.yml`
- Caching drop-ins: `wp-content/object-cache.php`, `wp-content/advanced-cache.php`, and `wp-content/cache/`
- Server-specific state: `wp-content/jetpack-waf/`, `wp-content/upgrade/`, `wp-content/upgrade-temp-backup/`, and `wp-content/debug.log` (on SpinupWP, a link to the site's `logs` folder)
- Migration-plugin backups: `wp-content/ai1wm-backups/`, `wp-content/updraft/`
- VCS and tool binaries, stray dumps, Local's helper files

Must-use plugins that exist only on the receiving side are never deleted.

To skip more, add rsync patterns (one per line) to `app/public/.spinupwp-push-ignore` or `.spinupwp-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

## Security notes

- **Secrets:** the API token and any typed site-user password are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). They are stored in `<Local data>/spinupwp-connect/settings.json` and never sent to the renderer. A password goes to `ssh` through `SSH_ASKPASS` and an environment variable, never in argv or on disk.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/spinupwp-connect/ssh/`, separate from Local's WP Engine key and from the other ConnectLocal add-ons' keys. It also keeps its own `known_hosts` file, which pins the server's host key on first connect.
- **What the add-on changes on SpinupWP:**
  - the site's files and database, when you push;
  - a private `~/.spinupwp-connect/files-<checksum>` folder in the site user's home, for dumps and the database backup;
  - `table_prefix` in `wp-config.php`, only when a push brings a different one;
  - SpinupWP's caches, when you push with the cache option on.
  It never adds or attaches SSH keys, changes the site user's authentication, or changes site settings; those stay in SpinupWP.
- **Shared SSH connection:** on macOS and Linux, each push, pull or comparison logs in once and runs every command over that connection. Its control socket is `spc-<hash>` in a temporary folder only your user can use.

## Verified on a live account

On 2026-11-07, against a new SpinupWP server on DigitalOcean (Ubuntu 26.04, MySQL 8.4, PHP 8.3, WP-CLI 2.12, rsync 3.4.1) with one fresh WordPress 7.1 site, through the add-on's main process with Local's services stubbed:

- **API:** a personal API token listed the account's 2 servers (one a failed, IP-less leftover) and its site. The site object also carries `user_auth` (`publickey` or `password`) and `subdomain.url`, the site's SpinupWP preview address (`*.spinupwp.site`).
- **SSH key:** Local's key was added under Account Settings → SSH Keys, then attached to the site user with `PUT /v1/sites/{id}/site-user`. SpinupWP applied it within seconds, and before that the server refused it, as expected.
- **Server layout:** the site user's home is `/sites/<domain>` with `files` (a full WordPress install), `logs` and `.ssh`. The SpinupWP plugin is active with its Redis `object-cache.php` drop-in (a real file), `wp-content/debug.log` is a root-owned link into `logs`, and `wp spinupwp cache purge-site` is available once plugins load.
- **Link through the API:** about 2 seconds. It found the webroot and made the private folder `~/.spinupwp-connect/files-<checksum>` (mode 700).
- **Pull** (files and database): about 10 seconds for 121 MB and 12 tables. Local kept its `wp-config.php`, the drop-in and the debug-log link stayed on the server, and URLs on the domain, the preview address and the `www` twin were replaced. A comparison right after found no differences.
- **Push** (files and database, deleting extra files): about 23 seconds. The new site title was served at once through the preview address with `fastcgi-cache: MISS`, after the API's page-cache and object-cache purges (both events `deployed`). No Local URLs were left, `wp-config.php`, the drop-in and the debug-log link were unchanged, and the previous database was saved in the private folder.
- **Compare and selective push:** a new Local file and a file only on the server were listed; the first was pushed and the second deleted, and a checksum comparison afterwards found no differences.

## Limitations and what is not verified

- **Bare domains in text:** like Local Connect, a push or pull replaces `//domain` URLs (and their JSON-escaped form), not a domain written without `//`, such as `example.com/profile` in link text or an email address.

- **Not yet run inside Local itself.** Try the Tools panel, header buttons and "Pull from SpinupWP" wizard in a running Local before relying on them.
- **Password logins:** built the same way as in the other ConnectLocal add-ons, but not yet tried against a SpinupWP site user.
- **No pre-push backup:** the API can't start one; rely on SpinupWP's scheduled backups, if on, and the database copy the add-on keeps.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password logins aren't supported (attach Local's key to the site user), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the API client (bearer token, sites and servers with pagination, cache purges, events, errors and rate limiting);
  - the site choices and the linking flow (server IP and port, site user, key first, then the typed password, then a clear error), with the API faked;
  - the remote discovery script on a SpinupWP-like home: `/sites/<domain>` with the webroot in `files`, and the private folder;
  - transfers of the whole webroot that keep `wp-config.php` and the excludes out, checked against a real rsync in both directions with `--delete`;
  - the cache purge through the API, and through the SpinupWP plugin without it;
  - dump normalization, URL replacement pairs, rsync itemize parsing and merging;
  - encrypted storage;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` and a SpinupWP-like site. Through Local's bundled `rsync`/`ssh`, it runs pushes, pulls, a comparison and selective syncs.

```
lib/
  main.js                 add-on main process: IPC handlers, account, site choices and linking flow
  main/SpinupWpApi.js     SpinupWP API client (token, sites, servers, page and object cache, events)
  main/SyncService.js     push and pull orchestration (discovery, files, database, search-replace, cache)
  main/transport.js       rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js          RSA key pair in OpenSSH format
  main/store.js           settings + encrypted secrets
  main/updater.js         checks GitHub releases and installs updates through Local's add-on installer
  renderer.js             hooks: Tools → SpinupWP tab, header pull/push buttons, create-site option, stylesheet
  renderer/components.js  React UI (plain React.createElement, no build step)
  renderer/siteMarks.js   logo marks in Local's sites list, shared with other ConnectLocal add-ons by DOM convention
```

### Sites-list marks (keep in sync across ConnectLocal add-ons)

Local has no hook for its sites list, so `renderer/siteMarks.js` adds the host's logo to each linked site's row
directly. Every ConnectLocal add-on carries its own copy of that file and follows the same convention, so their
logos share one strip per row instead of colliding:

- one `span[data-connectlocal-marks]` per row, right after the site name, created by whichever add-on needs it first
  and removed by whichever add-on empties it;
- one `span[data-connectlocal-host="<host>"]` per linked add-on inside it, in alphabetical order of the host key;
- inline styles only, so a mark never relies on another add-on's stylesheet.

A new host's add-on keeps `siteMarks.js` unchanged and only changes the `hostKey`, `label`, `color` and IPC channel
it passes in from `renderer.js`. If the convention itself changes, change it in every add-on.

### SpinupWP API endpoints used

| Purpose | Endpoint |
| --- | --- |
| Auth | `Authorization: Bearer <token>` (personal or team API token). 60 requests a minute; a 429 is retried. |
| Sites | `GET /v1/sites?page=&limit=100`, `GET /v1/sites/{id}` (`domain`, `additional_domains`, `site_user`, `public_folder`, `is_wordpress`, `status`) |
| Servers | `GET /v1/servers?page=&limit=100`, `GET /v1/servers/{id}` (`name`, `ip_address`, `ssh_port`) |
| Caches | `POST /v1/sites/{id}/page-cache/purge`, `POST /v1/sites/{id}/object-cache/purge` |
| Events | `GET /v1/events/{id}` (polled until `deployed` or `failed`) |

The base URL is `https://api.spinupwp.app`. The API is labelled beta by SpinupWP.

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
