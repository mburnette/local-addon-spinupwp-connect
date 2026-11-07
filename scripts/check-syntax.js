'use strict';

/** Parses every source and test file with `node --check`; the add-on ships unbundled, so this is its build gate. */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [];
(function walk(dir) {
	fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.name.endsWith('.js')) files.push(full);
	});
}(root));

let failed = 0;
files.forEach((file) => {
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
	} catch (e) {
		failed += 1;
		console.error(e.stderr.toString());
	}
});
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
