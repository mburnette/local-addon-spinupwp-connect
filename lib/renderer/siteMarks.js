'use strict';

/**
 * "Linked to a host" marks, shared by every ConnectLocal add-on WITHOUT shared code.
 *
 * Local has no hook for its sites list, so each add-on adds its own small logo tile to the rows it is linked to,
 * following one DOM convention so that several add-ons (Cloudways, Bluehost, Kinsta, ...) line their tiles up in a
 * single strip instead of fighting over the row. Every add-on carries its own copy of this file; keep the
 * convention below identical across copies (and in any future add-on), changing only what renderer.js passes in.
 *
 *   Row:        a.TID_SiteListSite[data-site-id]          (Local's own sidebar link for each site)
 *   Strip:      span[data-connectlocal-marks]             one per row, created by whichever add-on needs it
 *                                                         first, placed right after the site name, removed by
 *                                                         whichever add-on leaves it empty
 *   Mark:       span[data-connectlocal-host="<hostKey>"]  one per linked add-on, kept in alphabetical order by
 *                                                         hostKey; each add-on touches only its own marks
 *
 * All styling is inline so a mark never depends on another add-on's stylesheet being loaded.
 */

const fs = require('fs');

const STRIP_ATTR = 'data-connectlocal-marks';
const HOST_ATTR = 'data-connectlocal-host';
const ROW_SELECTOR = 'a.TID_SiteListSite[data-site-id]';
const NAME_SELECTOR = '.TID_SiteListSite_Span_SiteName';

const STRIP_STYLE = 'display:inline-flex;align-items:center;gap:3px;flex-shrink:0;margin-left:6px;line-height:0;';
const MARK_SIZE = 14;

function iconDataUri(iconPath) {
	try {
		return `data:image/svg+xml;base64,${fs.readFileSync(iconPath).toString('base64')}`;
	} catch (e) {
		return null;
	}
}

/**
 * @param {object} options
 * @param {string} options.hostKey     lowercase key that orders the marks, e.g. 'cloudways'
 * @param {string} options.label       host name for tooltips, e.g. 'Cloudways'
 * @param {string} options.iconPath    absolute path to the add-on's icon.svg
 * @param {string} options.color       brand colour, used if the icon can't be read
 * @param {() => Promise<Object<string, string|null>>} options.fetchLinked  siteId -> remote domain for linked sites
 */
module.exports = function createSiteMarks({ hostKey, label, iconPath, color, fetchLinked }) {
	const icon = iconDataUri(iconPath);
	let linked = {};
	const listeners = new Set();
	let observer = null;
	let frame = null;

	const tooltip = (siteId) => (linked[siteId] ? `Linked to ${label} (${linked[siteId]})` : `Linked to ${label}`);

	function makeMark(siteId) {
		const mark = document.createElement('span');
		mark.setAttribute(HOST_ATTR, hostKey);
		mark.style.cssText = `display:inline-block;width:${MARK_SIZE}px;height:${MARK_SIZE}px;border-radius:3px;flex-shrink:0;`
			+ (icon ? `background-image:url("${icon}");background-size:contain;background-repeat:no-repeat;` : `background-color:${color};`);
		mark.title = tooltip(siteId);
		mark.setAttribute('aria-label', mark.title);
		mark.setAttribute('role', 'img');
		return mark;
	}

	function placeMark(strip, mark) {
		const after = [...strip.children].find((el) => (el.getAttribute(HOST_ATTR) || '') > hostKey);
		strip.insertBefore(mark, after || null);
	}

	function ensureStrip(row) {
		let strip = row.querySelector(`[${STRIP_ATTR}]`);
		if (strip) return strip;
		strip = document.createElement('span');
		strip.setAttribute(STRIP_ATTR, '');
		strip.style.cssText = STRIP_STYLE;
		const name = row.querySelector(NAME_SELECTOR);
		row.insertBefore(strip, name ? name.nextSibling : null);
		return strip;
	}

	/** Brings every visible row in line with `linked`. Only writes to the DOM when something is wrong. */
	function apply() {
		frame = null;
		document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
			const siteId = row.getAttribute('data-site-id');
			const existing = row.querySelector(`[${STRIP_ATTR}] > [${HOST_ATTR}="${hostKey}"]`);
			if (Object.prototype.hasOwnProperty.call(linked, siteId)) {
				if (!existing) placeMark(ensureStrip(row), makeMark(siteId));
				else if (existing.title !== tooltip(siteId)) {
					existing.title = tooltip(siteId);
					existing.setAttribute('aria-label', existing.title);
				}
			} else if (existing) {
				const strip = existing.parentNode;
				existing.remove();
				if (!strip.children.length) strip.remove();
			}
		});
	}

	function schedule() {
		if (frame === null) frame = requestAnimationFrame(apply);
	}

	async function refresh() {
		try {
			linked = (await fetchLinked()) || {};
		} catch (e) {
			return;
		}
		schedule();
		listeners.forEach((fn) => fn(linked));
	}

	/** Starts watching the sites list (it re-renders and remounts rows often) and loads the linked sites. */
	function start() {
		if (observer || typeof MutationObserver === 'undefined') return;
		observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });
		refresh();
	}

	function stop() {
		if (observer) observer.disconnect();
		observer = null;
		if (frame !== null) cancelAnimationFrame(frame);
		frame = null;
	}

	/** React hook: true while the given site is linked to this host. */
	function useLinked(React, siteId) {
		const [, rerender] = React.useState(0);
		React.useEffect(() => {
			const fn = () => rerender((n) => n + 1);
			listeners.add(fn);
			return () => listeners.delete(fn);
		}, []);
		return Boolean(siteId) && Object.prototype.hasOwnProperty.call(linked, siteId);
	}

	return { start, stop, refresh, apply, useLinked, getLinked: () => linked };
};
