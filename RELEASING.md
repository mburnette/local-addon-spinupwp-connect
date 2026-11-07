# Releasing ConnectLocal for SpinupWP

Every GitHub release with a `.tgz` attached is an update. Installed copies check for one when Local starts and every
12 hours after that, or right away from **Check for updates** at the bottom of the add-on's panel. When there is
an update, the panel shows an **Update** button, which installs it through Local's own add-on installer and then
offers to restart Local.

## One-time setup

1. Install the GitHub CLI and sign in. Run `brew install gh`, then `gh auth login`.
2. Install the dependencies in this folder with `npm install`. The release bundles `@getflywheel/local-components` and `lodash` into the `.tgz`, so they must be installed.
3. Make sure `repository` in `package.json` names the public GitHub repo, currently `github:mburnette/local-addon-spinupwp-connect`. Installed copies look for updates there, and the release script stops if it is missing or doesn't match the repo this folder pushes to.

## Make a release

1. Write what changed under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), one bullet per change, in words a user
   would understand. Leave the version number out; the script adds it.
2. Commit your changes to `main`.
3. Run one of these:

   ```bash
   npm run release -- patch
   ```

   - `patch` for fixes (0.1.0 → 0.1.1)
   - `minor` for new features (0.1.0 → 0.2.0)
   - `major` for breaking changes (0.1.0 → 1.0.0)
   - an exact version, such as `npm run release -- 0.3.0`

The script:

1. stops if you have uncommitted changes, aren't on `main`, or have nothing under `## Unreleased`;
2. runs `npm run lint` and `npm test`;
3. bumps the version in `package.json`;
4. moves the `## Unreleased` notes under a new `## X.Y.Z - date` heading in `CHANGELOG.md`;
5. packs the `.tgz`;
6. commits `Release vX.Y.Z`, tags it and pushes;
7. creates the GitHub release with those notes and two copies of the `.tgz` attached:
   `local-addon-spinupwp-connect-X.Y.Z.tgz` and `local-addon-spinupwp-connect.tgz`.

To check a build without publishing anything, run:

```bash
npm run release -- patch --dry-run
```

It leaves the `.tgz` in the folder so you can try it with Local's **Add-ons → Install from disk**.

## Download link for the website

The copy without a version number keeps the same name in every release, so this link always downloads the newest
full release:

```
https://github.com/mburnette/local-addon-spinupwp-connect/releases/latest/download/local-addon-spinupwp-connect.tgz
```

The release script prints the exact link when it finishes. Like the in-app updater, it skips drafts and pre-releases.
The website reads the version number from the same GitHub release, so it updates on its own too.

## Things to know

- **Each version number can be released only once.** If a release is broken, publish a new patch release instead of reusing the tag.
- **Draft and pre-release releases are ignored.** The add-on asks GitHub for the latest full release, which skips drafts and pre-releases. Mark a release as a pre-release to share a test build without offering it to everyone.
- **Development copies never update themselves.** If Local's add-ons folder holds a symlink to this folder (from `npm run install-addon`), the panel tells you an update exists but has no Update button. Pull the changes with git instead.
- **Raising the required Local version.** If a release needs a newer Local, raise `engines.local-by-flywheel` in `package.json`. Local refuses to install the update on older versions and says why.
- **Anyone can download releases.** The repository is public, which installed copies need: they check GitHub for updates without signing in.
