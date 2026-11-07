'use strict';

const path = require('path');
const { ipcRenderer } = require('electron');
const { ipcAsync } = require('@getflywheel/local/renderer');

const { IPC } = require('./constants');
const createComponents = require('./renderer/components');
const createSiteMarks = require('./renderer/siteMarks');

const NEW_SITE_ROUTE = '/main/spinupwp-pull';

module.exports = function SpinupWPConnectRenderer(context) {
	const { React, ReactRouter, hooks } = context;
	const h = React.createElement;
	const { SpinupWPPanel, HeaderButtons, NewSitePage } = createComponents(context);

	// Logo mark next to linked sites in Local's sites list (see siteMarks.js for the cross-add-on convention).
	const marks = createSiteMarks({
		hostKey: 'spinupwp',
		label: 'SpinupWP',
		iconPath: path.join(__dirname, '..', 'icon.svg'),
		color: '#87a8ed',
		fetchLinked: () => ipcAsync(IPC.LINKED_SITES),
	});
	ipcRenderer.on(IPC.STATE_CHANGED, () => marks.refresh());
	marks.start();

	/** Tools tab entry: the host name, with a check while this site is linked. */
	function ToolsMenuLabel({ siteId }) {
		const isLinked = marks.useLinked(React, siteId);
		return h('span', { className: 'SPConnect_MenuLabel' },
			'SpinupWP',
			isLinked ? h('svg', {
				className: 'SPConnect_LinkedCheck',
				viewBox: '0 0 16 16',
				role: 'img',
				'aria-label': 'Linked',
			}, h('title', null, 'Linked'), h('path', { d: 'M3.5 8.5l3 3 6-7', fill: 'none' })) : null);
	}

	hooks.addContent('stylesheets', () => h('link', {
		key: 'spinupwp-connect-styles',
		rel: 'stylesheet',
		href: path.join(__dirname, 'renderer', 'styles.css'),
	}));

	// A "SpinupWP" entry under the site's Tools tab: account connection, linking, and push/pull options.
	hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps } = {}) => [
		...items,
		{
			path: '/spinupwp-connect',
			menuItem: h(ToolsMenuLabel, { siteId: routeChildrenProps && routeChildrenProps.site && routeChildrenProps.site.id }),
			render: () => h(SpinupWPPanel, {
				site: routeChildrenProps && routeChildrenProps.site,
				siteStatus: routeChildrenProps && routeChildrenProps.siteStatus,
			}),
		},
	]);

	// "SpinupWP: Pull / Push" buttons in the site header, next to Local Connect's own push/pull buttons.
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => h(HeaderButtons, {
		key: 'spinupwp-connect-buttons',
		site,
		siteStatus,
	}));

	// "Pull from SpinupWP" in Local's Create a site wizard. The option key is the route Continue navigates to.
	hooks.addFilter('CreateSite:RadioOptions', (options) => ({
		...options,
		[NEW_SITE_ROUTE.replace(/^\/main\//, '')]: {
			label: 'Pull from SpinupWP',
			content: 'Create a new Local site from a SpinupWP WordPress website, files and database.',
		},
	}));

	hooks.addContent('routes[main]', () => h(ReactRouter.Route, {
		key: 'spinupwp-connect-new-site',
		path: NEW_SITE_ROUTE,
		render: ({ history }) => h(NewSitePage, { history }),
	}));
};
