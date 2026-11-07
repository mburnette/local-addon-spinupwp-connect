'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';

/** Seconds a shared SSH connection stays open after its last use. */
const CONTROL_PERSIST_SECONDS = 120;

/** Single-quotes a value for a POSIX remote shell. */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Converts a native path to the form Local's bundled (Cygwin) rsync/ssh expect on Windows: C:\a\b -> /c/a/b.
 * Mirrors Local's own osPath.toPOSIX(). No-op elsewhere.
 */
function toPosixPath(p) {
	if (!isWindows) return p;
	const isNetworkPath = p.startsWith('\\\\');
	let posix = p.replace(/\\/g, '/');
	if (posix.indexOf(':') === 1) posix = posix.replace(':', '');
	const parts = posix.split('/').filter(Boolean);
	if (parts[0] && parts[0].length === 1) parts[0] = parts[0].toLowerCase();
	posix = `/${parts.join('/')}`;
	return isNetworkPath ? `/${posix}` : posix;
}

/** Directory holding the rsync + OpenSSH binaries Local ships for Local Connect (null on Linux: use the system's). */
function findBundledBinDir() {
	if (process.platform === 'linux') return null;
	const platformDir = isWindows ? 'win32' : 'darwin';
	const roots = [
		process.electronPaths && process.electronPaths.resourcesPath,
		process.resourcesPath && path.join(process.resourcesPath, 'extraResources'),
		process.resourcesPath,
	].filter(Boolean);
	for (const root of roots) {
		const dir = path.join(root, 'bin', 'rsync', platformDir);
		if (fs.existsSync(path.join(dir, isWindows ? 'rsync.exe' : 'rsync'))) return dir;
	}
	return null;
}

/**
 * Runs rsync and ssh against a SpinupWP server as the site's site user (port 22 unless the server says otherwise) with either the add-on's SSH key or
 * the site's SSH password.
 *
 * Password auth works by pointing SSH_ASKPASS at a tiny script that echoes a password passed through the process
 * environment (OpenSSH >= 8.4 honours SSH_ASKPASS_REQUIRE=force), so the password never appears in argv or on disk.
 */
/** rsync binary -> Promise<boolean>: whether it accepts --protect-args. */
const protectArgsSupport = new Map();

class Transport {
	constructor({ host, port = 22, username, privateKeyPath, password, workDir, logger = console }) {
		if (!host || !username) throw new Error('A host and username are required to connect to SpinupWP.');
		if (!privateKeyPath && !password) throw new Error('Either an SSH key or a password is required.');
		this.host = host;
		this.port = Number(port) || 22;
		this.username = username;
		this.privateKeyPath = password ? null : privateKeyPath;
		this.password = password || null;
		this.workDir = workDir;
		this.knownHostsPath = path.join(workDir, 'known_hosts');
		this.logger = logger;
		this.binDir = findBundledBinDir();
		// A single push runs dozens of commands, and a fresh SSH login for each is slow, so every ssh and rsync call
		// goes through one multiplexed connection. Unix socket paths are limited to ~104 bytes and ssh adds a
		// 17-character suffix while binding, so macOS's long per-user temp dir does not fit; /tmp does. %C is a
		// 40-character hash of host, port and user. Not available with the Windows build of ssh.
		const socketDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
		this.controlPath = isWindows ? null : path.join(socketDir, 'spc-%C');
		this._used = false;
	}

	/** Closes the shared connection, if a command opened one. */
	async close() {
		if (!this.controlPath || !this._used) return;
		this._used = false;
		await new Promise((resolve) => {
			const child = spawn(this._bin('ssh'), [...this._sshOptions(), '-O', 'exit', `${this.username}@${this.host}`], {
				env: this._env(), stdio: 'ignore', windowsHide: true,
			});
			child.on('error', resolve);
			child.on('exit', resolve);
		});
	}

	_bin(name) {
		if (!this.binDir) return name;
		return path.join(this.binDir, isWindows ? `${name}.exe` : name);
	}

	_env() {
		const env = { ...process.env };
		if (this.binDir) env.PATH = `${this.binDir}${path.delimiter}${process.env.PATH || ''}`;
		if (this.password) {
			if (isWindows) {
				throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
			}
			const askpass = path.join(this.workDir, 'askpass.sh');
			if (!fs.existsSync(askpass)) {
				fs.mkdirSync(this.workDir, { recursive: true });
				fs.writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$SPINUPWP_CONNECT_SSH_PASS"\n', { mode: 0o700 });
			}
			env.SSH_ASKPASS = askpass;
			env.SSH_ASKPASS_REQUIRE = 'force';
			env.DISPLAY = env.DISPLAY || ':0';
			env.SPINUPWP_CONNECT_SSH_PASS = this.password;
		}
		return env;
	}

	/** ssh options as an argv array. */
	_sshOptions() {
		fs.mkdirSync(this.workDir, { recursive: true });
		const opts = [
			'-F', '/dev/null',
			'-p', String(this.port),
			'-o', 'ServerAliveInterval=60',
			'-o', 'ServerAliveCountMax=120',
			'-o', 'ConnectTimeout=30',
			'-o', 'StrictHostKeyChecking=accept-new',
			'-o', `UserKnownHostsFile=${toPosixPath(this.knownHostsPath)}`,
		];
		if (this.controlPath) {
			// The first command becomes the shared connection and stays in the background (its stdio on /dev/null)
			// for later commands. A master started on its own with -N would refuse their sessions.
			opts.push('-o', `ControlPath=${this.controlPath}`, '-o', 'ControlMaster=auto', '-o', `ControlPersist=${CONTROL_PERSIST_SECONDS}`);
		}
		if (this.password) {
			opts.push(
				'-o', 'PreferredAuthentications=password,keyboard-interactive',
				'-o', 'PubkeyAuthentication=no',
				'-o', 'NumberOfPasswordPrompts=1',
			);
		} else {
			opts.push(
				'-o', 'BatchMode=yes',
				'-o', 'IdentitiesOnly=yes',
				'-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
				'-i', toPosixPath(this.privateKeyPath),
			);
		}
		return opts;
	}

	/** The same options flattened into rsync's -e string; rsync honours double quotes when splitting it. */
	_rsyncShell() {
		return ['ssh', ...this._sshOptions().map((o) => (/\s/.test(o) ? `"${o}"` : o))].join(' ');
	}

	_spawn(cmd, args, { onStdout } = {}) {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = spawn(cmd, args, { env: this._env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
			} catch (e) {
				reject(e);
				return;
			}
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (d) => {
				const s = d.toString();
				stdout += s;
				if (onStdout) onStdout(s);
			});
			child.stderr.on('data', (d) => {
				stderr += d.toString();
			});
			child.on('error', reject);
			child.on('close', (code) => resolve({ code, stdout, stderr }));
		});
	}

	/** Runs a command in the remote (bash) shell. Rejects on a non-zero exit with stderr in the message. */
	async exec(command, { allowFailure = false } = {}) {
		this._used = true;
		const args = [...this._sshOptions(), `${this.username}@${this.host}`, command];
		this.logger.debug && this.logger.debug(`[spinupwp-connect] ssh ${this.username}@${this.host}: ${command}`);
		const { code, stdout, stderr } = await this._spawn(this._bin('ssh'), args);
		if (code !== 0 && !allowFailure) {
			throw new TransportError(describeSshFailure(code, stderr, this), code, stderr);
		}
		return { code, stdout, stderr };
	}

	/**
	 * Syncs a local directory or file to the server. Returns rsync's stdout.
	 * @param {object} args
	 * @param {string} args.source local path; a trailing slash syncs the directory's contents
	 * @param {string} args.destination absolute remote path
	 * @param {string[]} [args.extraArgs]
	 * @param {(line: string) => void} [args.onFile] called with each changed path
	 */
	rsyncUp({ source, destination, extraArgs = [], onFile }) {
		return this._rsync([...extraArgs, localRsyncPath(source), this._remoteRsyncPath(destination)], onFile);
	}

	/** Mirror of rsyncUp: syncs an absolute remote path (trailing slash = contents) down to a local path. */
	rsyncDown({ source, destination, extraArgs = [], onFile }) {
		return this._rsync([...extraArgs, this._remoteRsyncPath(source), localRsyncPath(destination)], onFile);
	}

	_remoteRsyncPath(remotePath) {
		return `${this.username}@${this.host}:${remotePath}`;
	}

	/**
	 * Whether this rsync understands --protect-args (rsync 3.0 and later). macOS's own /usr/bin/rsync is openrsync,
	 * which rejects it; that one is only used when Local's bundled rsync can't be found. Asked once per binary.
	 */
	async _supportsProtectArgs() {
		const bin = this._bin('rsync');
		if (!protectArgsSupport.has(bin)) {
			protectArgsSupport.set(bin, this._spawn(bin, ['--version'])
				.then(({ stdout }) => /^rsync\s+version\s+(?:[3-9]|\d{2,})\./m.test(stdout))
				.catch(() => false));
		}
		return protectArgsSupport.get(bin);
	}

	async _rsync(pathsAndFlags, onFile) {
		this._used = true;
		// --protect-args: Local's rsync 3.1.3 otherwise hands the remote path to the server's shell unquoted, so a folder
		// such as ".../public_html/old site" is split at the space and a push (with --delete) lands in ".../public_html/old".
		// An rsync without it may only be given remote paths the server's shell can't split or expand.
		const protect = await this._supportsProtectArgs();
		if (!protect) {
			const remote = pathsAndFlags.find((a) => a.startsWith(`${this.username}@${this.host}:`));
			if (remote && !/^[\w.@:/+~-]+$/.test(remote)) {
				throw new TransportError(`The rsync on this computer is too old to transfer ${remote.split(':').slice(1).join(':')} safely `
					+ '(its path has spaces or special characters). Run the add-on inside Local, which bundles a newer rsync.', 1, '');
			}
		}
		const args = ['-e', this._rsyncShell(), ...(protect ? ['--protect-args'] : []), ...pathsAndFlags];
		this.logger.debug && this.logger.debug(`[spinupwp-connect] rsync ${args.join(' ')}`);
		let buffered = '';
		const { code, stdout, stderr } = await this._spawn(this._bin('rsync'), args, {
			onStdout: (chunk) => {
				if (!onFile) return;
				buffered += chunk;
				const lines = buffered.split(/\r?\n/);
				buffered = lines.pop();
				lines.forEach((line) => {
					if (line.startsWith('Changed:')) onFile(line.slice('Changed:'.length));
				});
			},
		});
		// 24 = "some files vanished before they could be transferred", harmless for a live site.
		if (code !== 0 && code !== 24) {
			throw new TransportError(describeSshFailure(code, stderr, this, 'rsync'), code, stderr);
		}
		return stdout;
	}
}

/** Local path in the form rsync expects, keeping a trailing slash (meaning "directory contents") if present. */
function localRsyncPath(p) {
	return p.endsWith(path.sep) || p.endsWith('/') ? `${toPosixPath(p.replace(/[\\/]+$/, ''))}/` : toPosixPath(p);
}

class TransportError extends Error {
	constructor(message, code, stderr) {
		super(message);
		this.name = 'TransportError';
		this.code = code;
		this.stderr = stderr;
	}
}

/** Where SpinupWP takes SSH keys (account-wide), and where a key or password is given to a site's site user. */
const SSH_KEYS_PATH = 'SpinupWP → Account Settings → SSH Keys';
const SITE_USER_PATH = 'the site\'s site user in SpinupWP';

function describeSshFailure(code, stderr, transport, tool = 'ssh') {
	const err = (stderr || '').trim();
	const where = `${transport.username}@${transport.host}:${transport.port}`;
	// Only an SSH login failure looks like this; a remote command's own "Permission denied" must not be read as one.
	if (/Permission denied \((publickey|password|keyboard-interactive)|Permission denied, please try again|Too many authentication failures/i.test(err)) {
		return transport.password
			? `SpinupWP refused the password for ${where}. Check that ${SITE_USER_PATH} uses password authentication, and the password set there.`
			: `SpinupWP refused the SSH key for ${where}. Add Local's public key in ${SSH_KEYS_PATH}, then attach it to ${SITE_USER_PATH} (Add SSH Key). The username is the site user.`;
	}
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(err)) {
		return `The host key for ${transport.host} changed. If the server was rebuilt, delete its entry from ${transport.knownHostsPath} and try again.`;
	}
	if (/Could not resolve hostname|Connection refused|timed out|No route to host/i.test(err)) {
		const hint = /Connection refused|timed out/i.test(err)
			? ' Check your internet connection, and that the host is the server\'s IP address and the port its SSH port (usually 22).'
			: '';
		return `Could not reach ${where}: ${err.split('\n').pop()}.${hint}`;
	}
	if (/command not found/i.test(err)) {
		return `A required command is missing on the server: ${err.split('\n').pop()}`;
	}
	const tail = err.split('\n').filter(Boolean).slice(-3).join(' ');
	if (tool === 'ssh' && code !== 255) {
		// ssh itself exits 255; any other code is the remote command's own exit status.
		return `A command failed on the SpinupWP server (exit ${code})${tail ? `: ${tail}` : '.'}`;
	}
	return `${tool} exited with code ${code}${tail ? `: ${tail}` : ''}`;
}

module.exports = { Transport, TransportError, shellQuote, toPosixPath, findBundledBinDir, describeSshFailure };
