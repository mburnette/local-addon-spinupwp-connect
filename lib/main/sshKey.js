'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Encodes a length-prefixed SSH wire-format string. */
function sshString(buf) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(buf.length, 0);
	return Buffer.concat([len, buf]);
}

/** Encodes an unsigned big-endian integer as an SSH mpint (leading zero when the high bit is set). */
function sshMpint(buf) {
	let b = buf;
	while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
	if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
	return sshString(b);
}

/** Converts a Node RSA public KeyObject into an OpenSSH "ssh-rsa AAAA... comment" line. */
function toOpenSshPublicKey(publicKey, comment) {
	const jwk = publicKey.export({ format: 'jwk' });
	const blob = Buffer.concat([
		sshString(Buffer.from('ssh-rsa')),
		sshMpint(Buffer.from(jwk.e, 'base64url')),
		sshMpint(Buffer.from(jwk.n, 'base64url')),
	]);
	return `ssh-rsa ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`;
}

/** OpenSSH-style SHA256 fingerprint ("SHA256:...") of an OpenSSH public key line. */
function fingerprint(openSshPublicKey) {
	const blob = Buffer.from(openSshPublicKey.trim().split(/\s+/)[1], 'base64');
	return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The add-on keeps its own key pair (separate from Local's WP Engine key) so adding it to SpinupWP never
 * interferes with Local Connect. RSA is used because every bundled OpenSSH build accepts it.
 */
class SshKeyStore {
	constructor(dir) {
		this.dir = dir;
		this.privateKeyPath = path.join(dir, 'id_rsa');
		this.publicKeyPath = `${this.privateKeyPath}.pub`;
	}

	exists() {
		return fs.existsSync(this.privateKeyPath) && fs.existsSync(this.publicKeyPath);
	}

	ensure(comment) {
		if (!this.exists()) {
			fs.mkdirSync(this.dir, { recursive: true });
			const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
			fs.writeFileSync(this.privateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
			fs.writeFileSync(this.publicKeyPath, `${toOpenSshPublicKey(publicKey, comment)}\n`, { mode: 0o644 });
		}
		// ssh refuses keys that other users can read.
		try {
			fs.chmodSync(this.privateKeyPath, 0o600);
		} catch (e) {
			// chmod is a no-op on Windows
		}
		return this.getPublicKey();
	}

	getPublicKey() {
		return fs.existsSync(this.publicKeyPath) ? fs.readFileSync(this.publicKeyPath, 'utf8').trim() : null;
	}

	getFingerprint() {
		const pub = this.getPublicKey();
		return pub ? fingerprint(pub) : null;
	}
}

module.exports = { SshKeyStore, toOpenSshPublicKey, fingerprint };
