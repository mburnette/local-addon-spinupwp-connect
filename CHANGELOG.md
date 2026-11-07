# Changelog

What changed in each release of ConnectLocal for SpinupWP. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

## 1.1.0 - 2026-11-07

- First release.
- Push a Local site's files, database, or both to a WordPress site on a SpinupWP server.
- Pull them back into an existing Local site, or into a brand-new Local site.
- Compare files on both sides and push or pull only the ones you pick.
- Find your sites with a SpinupWP API token (personal or team), grouped by server. The add-on reads each site's server IP address, SSH port and site user from the API. Or connect with the server's IP address and the site user.
- Log in as the site user with Local's SSH key (added once in SpinupWP and attached to the site user), or with the site user's password (stored encrypted).
- Leave `wp-config.php` and the caching drop-ins alone on both sides.
- Purge SpinupWP's page cache and object cache after a push.
- Sites linked to SpinupWP show a small SpinupWP logo next to their name in Local's sites list. Other ConnectLocal
  add-ons show theirs in the same spot, so a site linked to several hosts shows each host's logo side by side.
  Hover a logo to see which SpinupWP site it is linked to.
- **Tools → SpinupWP** shows a green check while the open site is linked.
- Update checks: the add-on looks for new releases on GitHub when Local starts and every 12 hours, and shows an
  **Update** button in its panel when one is out. **Check for updates** at the bottom of the panel checks right away.

