'use strict';

/**
 * Symlinks this folder into Local's add-ons directory and marks it enabled, the documented way to develop an
 * add-on (https://localwp.com/help-docs/designing-your-add-on/where-should-put-my-add-on/). Restart Local afterwards.
 *
 *   npm run install-addon            install / enable
 *   npm run install-addon -- --remove
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');

function localUserDataDir() {
	switch (process.platform) {
		case 'darwin':
			return path.join(os.homedir(), 'Library', 'Application Support', 'Local');
		case 'win32':
			return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Local');
		default:
			return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Local');
	}
}

const userData = localUserDataDir();
const addonsDir = path.join(userData, 'addons');
const target = path.join(addonsDir, pkg.name);
const enabledFile = path.join(userData, 'enabled-addons.json');
const source = path.resolve(__dirname, '..');
const remove = process.argv.includes('--remove');

if (!fs.existsSync(userData)) {
	console.error(`Local's data folder was not found at ${userData}. Is Local installed and opened at least once?`);
	process.exit(1);
}

let enabled = {};
try {
	enabled = JSON.parse(fs.readFileSync(enabledFile, 'utf8'));
} catch (e) {
	// first add-on
}

if (fs.existsSync(target) || isDanglingLink(target)) {
	const stat = fs.lstatSync(target);
	if (!stat.isSymbolicLink()) {
		console.error(`${target} exists and is not a symlink; remove it manually to avoid deleting a real install.`);
		process.exit(1);
	}
	fs.unlinkSync(target);
}

if (remove) {
	delete enabled[pkg.name];
	fs.writeFileSync(enabledFile, JSON.stringify(enabled));
	console.log(`Removed ${pkg.productName}. Restart Local to unload it.`);
	process.exit(0);
}

if (!fs.existsSync(path.join(source, 'node_modules', '@getflywheel', 'local-components'))) {
	console.error('Run `npm install` first; the add-on needs its node_modules.');
	process.exit(1);
}

fs.mkdirSync(addonsDir, { recursive: true });
fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
enabled[pkg.name] = true;
fs.writeFileSync(enabledFile, JSON.stringify(enabled));
console.log(`Linked ${source}\n    -> ${target}\nEnabled ${pkg.productName}. Restart Local to load it (Local may rewrite enabled-addons.json if it is open; if the add-on shows as disabled, enable it under Add-ons → Installed).`);

function isDanglingLink(p) {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch (e) {
		return false;
	}
}
