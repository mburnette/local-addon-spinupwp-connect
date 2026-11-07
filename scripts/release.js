'use strict';

/**
 * Publishes a new version as a GitHub release that installed copies of the add-on pick up as an update.
 *
 *   npm run release -- patch            0.1.0 -> 0.1.1 (also: minor, major, or an exact version like 0.3.0)
 *   npm run release -- patch --dry-run  bump, test and pack, but don't commit, push or publish
 *
 * Steps: checks the working tree is clean and CHANGELOG.md has notes under "## Unreleased", runs lint + tests, bumps
 * the version, moves those notes under the new version's heading, packs the .tgz with its bundled dependencies,
 * commits and tags vX.Y.Z, pushes, then creates the GitHub release with the notes and the .tgz attached (once under
 * its versioned name and once under a fixed name for the website's "latest" link).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { githubRepoFrom } = require('../lib/main/updater');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--'));
const changelogPath = path.join(root, 'CHANGELOG.md');

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', ...opts });
const read = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
	console.error(`\n✖ ${message}`);
	process.exit(1);
};

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(bump)) {
	fail('Say which version to release: npm run release -- patch | minor | major | 1.2.3');
}

if (read('git', ['status', '--porcelain'])) fail('Commit or stash your changes first; a release is built from a clean working tree.');
const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`Releases are made from main (you're on ${branch}).`);

// The notes under "## Unreleased" become this version's changelog entry and the GitHub release notes.
const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
const unreleased = changelog.search(/^## Unreleased\b/m);
if (unreleased < 0) fail('CHANGELOG.md needs a "## Unreleased" section.');
const notesStart = changelog.indexOf('\n', unreleased) + 1;
const nextVersion = changelog.slice(notesStart).search(/^## /m);
const notesEnd = nextVersion < 0 ? changelog.length : notesStart + nextVersion;
const notes = changelog.slice(notesStart, notesEnd).trim();
if (!notes) fail('Write what changed under "## Unreleased" in CHANGELOG.md and commit it first.');
// Installed copies find their updates through package.json's repository field, so a release without it can never update.
const repo = githubRepoFrom(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
if (!repo) fail('Set "repository" in package.json to the GitHub repo (owner/name) that hosts the releases.');
if (!dryRun) {
	try {
		read('gh', ['auth', 'status']);
	} catch (e) {
		fail('Sign in to GitHub first: gh auth login');
	}
	const ghRepo = read('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
	if (ghRepo.toLowerCase() !== repo.toLowerCase()) fail(`package.json says releases live in ${repo}, but this folder pushes to ${ghRepo}.`);
}

console.log('→ Checking syntax and running tests');
run('npm', ['run', 'lint']);
run('npm', ['test']);

console.log(`→ Bumping version (${bump})`);
run('npm', ['version', bump, '--no-git-tag-version']);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;
if (read('git', ['tag', '--list', tag])) fail(`${tag} already exists.`);
const date = new Date().toLocaleDateString('en-CA');
fs.writeFileSync(changelogPath, `${changelog.slice(0, notesStart)}\n## ${pkg.version} - ${date}\n\n${notes}\n\n${changelog.slice(notesEnd)}`);

console.log('→ Packing');
const tgz = read('npm', ['pack', '--silent']).split('\n').pop();
const tgzPath = path.join(root, tgz);
console.log(`  ${tgz} (${(fs.statSync(tgzPath).size / 1024 / 1024).toFixed(1)} MB)`);
// The same file under a name that never changes, so .../releases/latest/download/<name> always gets the newest version.
const latestName = `${pkg.name}.tgz`;
const latestPath = path.join(root, latestName);
fs.copyFileSync(tgzPath, latestPath);

if (dryRun) {
	run('git', ['checkout', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
	fs.rmSync(latestPath);
	console.log(`\n✓ Dry run finished. ${tgz} is ready to try with Local's Add-ons → Install from disk; nothing was committed or published.`);
	process.exit(0);
}

console.log(`→ Committing and tagging ${tag}`);
run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
run('git', ['commit', '-m', `Release ${tag}`]);
run('git', ['tag', '-a', tag, '-m', `${pkg.productName} ${pkg.version}`]);
run('git', ['push', '--follow-tags', 'origin', 'main']);

console.log('→ Publishing the GitHub release');
run('gh', ['release', 'create', tag, tgzPath, latestPath, '--title', `${pkg.productName} ${pkg.version}`, '--notes', notes]);
fs.rmSync(tgzPath);
fs.rmSync(latestPath);

console.log(`\n✓ Released ${tag}. Installed copies will offer the update within 12 hours, or right away from "Check for updates".`);
console.log(`  Latest download: https://github.com/${repo}/releases/latest/download/${latestName}`);
