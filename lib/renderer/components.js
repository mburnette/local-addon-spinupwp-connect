'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

/** SpinupWP's guides: the API, and adding SSH keys to site users. */
const API_HELP_URL = 'https://api.spinupwp.com/';
const SSH_HELP_URL = 'https://spinupwp.com/doc/how-to-ssh-keys/';

/** Where SpinupWP takes SSH keys (account-wide); each key is then attached to a site user. */
const SSH_KEYS_PATH = 'Account Settings → SSH Keys';
const SITE_USER_PATH = 'the site\'s site user (Add SSH Key)';

/** SpinupWP servers listen for SSH on port 22 by default. */
const DEFAULT_SSH_PORT = '22';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function useSpinupWPState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	/** Step-by-step progress the main process reports while connecting or linking. `start()` returns a progressId. */
	function useLinkProgress() {
		const [progress, setProgress] = useState(null);
		const idRef = React.useRef(null);
		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === idRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);
		const start = () => {
			idRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setProgress(null);
			return idRef.current;
		};
		return { progress, start };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	const openLink = (url) => (e) => {
		e.preventDefault();
		shell.openExternal(url);
	};

	function Field({ label, help, children }) {
		return h('label', { className: 'SPConnect_Field' },
			h('span', { className: 'SPConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'SPConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'SPConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'SPConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'SPConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `SPConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'SPConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'SPConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Password or SSH key, as radio buttons. Password is offered only where the platform supports it. */
	function AuthChoice({ state, value, onChange }) {
		return h('div', { className: 'SPConnect_AuthChoice' },
			state.passwordAuthSupported
				? h('label', null, h('input', { type: 'radio', checked: value === 'password', onChange: () => onChange('password') }), ' Password')
				: null,
			h('label', null, h('input', { type: 'radio', checked: value === 'key', onChange: () => onChange('key') }), ' SSH key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to SpinupWP',
			defaults: () => ({ files: true, database: true, deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in app/public except wp-config.php)'],
				['database', 'Database (with URL search & replace)'],
				options.files && ['deleteRemote', 'Delete files on SpinupWP that are not in Local'],
				['purgeCache', link.mode === 'account'
					? 'Clear SpinupWP caches afterwards (page cache and object cache)'
					: 'Clear caches afterwards (WordPress\'s object cache, and the page cache through the SpinupWP plugin)'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local. Visitors see the change right away.`,
				options.database && 'The SpinupWP database is replaced; the previous one is saved as local-backup-before-push.sql in a private .spinupwp-connect folder in the site user\'s home folder, outside the website.',
				options.files && options.deleteRemote && 'Files on SpinupWP that do not exist locally will be deleted. wp-config.php, the caching drop-ins and must-use plugins that only exist on the server are never touched.',
				'This push does not make a SpinupWP backup. If the site has backups turned on in SpinupWP, you can restore one from the site\'s Backups page.',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from SpinupWP',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in the webroot except wp-config.php, server config and caches)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on SpinupWP'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Local files that do not exist on SpinupWP will be deleted.',
				options.files && 'Local files the pull replaces or deletes are moved to app/spinupwp-backups (the last 3 pulls are kept).',
			],
		},
	};

	const linkTarget = (link) => link.label || link.domain || link.host;

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = linkTarget(link);
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, link, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} SpinupWP?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'SPConnect_TransferForm' },
			h('div', { className: 'SPConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'SPConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'SPConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	const describeAuth = (link) => (link.authType === 'password'
		? `Site user's password (stored encrypted). Add Local's SSH key in SpinupWP → ${SSH_KEYS_PATH}, attach it to ${SITE_USER_PATH}, and link again to use the key instead.`
		: 'Local\'s SSH key');

	/** The SpinupWP server a link's site lives on. */
	const describeServer = (link) => (link.serverName ? (link.serverName !== link.host ? `${link.serverName} (${link.host})` : link.host) : null);

	/** Folders inside the webroot that are never transferred: other WordPress installs and other websites. */
	const neverSynced = (link) => [...new Set([...(link.nested || []), ...(link.excludeDirs || [])])];

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [direction, setDirection] = useState('push');

		const skipped = neverSynced(link);
		const rows = [
			link.label && ['Site', link.label],
			link.domain && !String(link.label || '').includes(link.domain) && ['Domain', link.domain],
			describeServer(link) && ['Server', describeServer(link)],
			['SSH login', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			link.remotePath && ['Remote path', link.remotePath],
			skipped.length ? ['Never synced', `Other sites in subfolders: ${skipped.join(', ')}`] : null,
			['Authentication', describeAuth(link)],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'SPConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to SpinupWP'], ['pull', 'Pull from SpinupWP'], ['compare', 'Compare & sync files']],
				className: 'SPConnect_Tabs SPConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'SPConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						// A push or pull installs WP-CLI in a private folder when the server has PHP but no `wp`.
						const wpCli = remote.hasWpCli ? '' : remote.hasPhp
							? ' (WP-CLI missing: the first database push or pull installs it in a private folder)'
							: ' (WP-CLI and PHP missing: database transfers will fail)';
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${wpCli}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id })),
				}, 'Unlink from SpinupWP')),
			testResult ? h('div', { className: 'SPConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/** Connects a SpinupWP API token, which lists the account's sites and the server and site user of each. */
	function AccountConnectForm() {
		const [apiKey, setApiKey] = useState('');
		const action = useAction();
		return h('div', { className: 'SPConnect_Form' },
			h('p', { className: 'SPConnect_Intro' },
				'Connect with a SpinupWP API token. Local then lists your sites, finds each one\'s server and site user for you, and purges SpinupWP\'s caches after a push. In SpinupWP, open ',
				h('strong', null, 'My Account → API Tokens'),
				' (or Team Settings → API Tokens for a team token), create a token and copy it. ',
				h('a', { href: '#', onClick: openLink(API_HELP_URL) }, 'SpinupWP\'s API docs')),
			h(Field, { label: 'API token', help: 'Stored encrypted with your system keychain.' },
				h(TextInput, { value: apiKey, onChange: setApiKey, type: 'password' })),
			h(BusyNote, { busy: action.busy }, 'Checking the token…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'SPConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !apiKey.trim(),
					onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { apiKey })),
				}, action.busy ? 'Connecting…' : 'Connect')));
	}

	/** "shop.example.com (site user shop)" or "shop.example.com (disabled)". */
	const choiceLabel = (choice) => {
		const address = choice.domain || choice.id;
		if (choice.linkable === false) return `${address} (${choice.reason || 'unavailable'})`;
		return choice.siteUser && choice.siteUser !== address ? `${address} (site user ${choice.siteUser})` : address;
	};
	const choiceName = (choice) => choice.displayName || choice.domain || '';
	const countSites = (n) => (typeof n === 'number' ? ` · ${n} site${n === 1 ? '' : 's'}` : '');
	const countServers = (n) => (typeof n === 'number' ? ` on ${n} server${n === 1 ? '' : 's'}` : '');

	/** Groups site choices under their `group` label (the server), keeping the main process's order. */
	const groupChoices = (choices) => {
		const groups = new Map();
		choices.forEach((choice) => {
			const label = choice.group || 'Sites';
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label).push(choice);
		});
		return [...groups.entries()];
	};

	/**
	 * Picks a site from the connected SpinupWP account. `onSubmit({ kind: 'account', id, password? , … })` links it
	 * (or, on the new-site page, creates a site and pulls it). The main process reads the site again by `id`; the SSH
	 * password is only sent when the user typed one.
	 */
	function AccountSetup({ state, submitLabel, canSubmit = true, onSubmit, onSiteSelected }) {
		const [choices, setChoices] = useState(null);
		const [selected, setSelected] = useState('');
		const [password, setPassword] = useState('');
		const action = useAction();
		const { progress, start } = useLinkProgress();

		const loadSites = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_SITES);
			setChoices(list);
			const first = list.find((c) => c.linkable !== false) || list[0];
			if (first) setSelected(first.id);
		}), [action.run]);

		useEffect(() => {
			if (state.account && choices === null) loadSites();
		}, [state.account]);

		const choice = choices && choices.find((c) => c.id === selected);
		const usable = Boolean(choice) && choice.linkable !== false;

		useEffect(() => {
			if (choice && onSiteSelected) onSiteSelected(choice);
		}, [choice && choice.id]);

		if (!state.account) return h(AccountConnectForm);

		const { account } = state;
		return h('div', { className: 'SPConnect_Form' },
			h('div', { className: 'SPConnect_Account' },
				h('span', null, 'Connected to ', h('strong', null, 'SpinupWP'), countSites(account.sites), countServers(account.servers)),
				h(TextButton, {
					onClick: () => action.run(async () => {
						await ipcAsync(IPC.DISCONNECT_ACCOUNT);
						setChoices(null);
					}),
				}, 'Disconnect')),
			choices === null
				// A failed listing shows its error (below) and the Refresh button instead of spinning forever.
				? h(BusyNote, { busy: !action.error }, 'Loading your SpinupWP sites…')
				: choices.length === 0
					? h('p', null, 'No sites were found for this API token. A team token only sees that team\'s sites; sites in another account can be linked with SSH details instead.')
					: h(Field, { label: 'Site', help: choice && !usable ? `This site can't be linked: ${choice.reason || 'unavailable'}.` : null },
						h('select', { className: 'SPConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							groupChoices(choices).map(([label, group]) => h('optgroup', { key: label, label },
								group.map((c) => h('option', { key: c.id, value: c.id, disabled: c.linkable === false }, choiceLabel(c))))))),
			choices && choices.length
				? h(React.Fragment, null,
					h(Field, {
						label: 'Local\'s SSH key',
						help: h(React.Fragment, null,
							`Add this key in SpinupWP → ${SSH_KEYS_PATH}, then attach it to ${SITE_USER_PATH}. Local logs in as the site user with it. `,
							h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'SpinupWP\'s SSH key guide')),
					}, h(PublicKeyBox)),
					state.passwordAuthSupported
						? h(Field, {
							label: 'Site user password (optional)',
							help: 'Only needed if you haven\'t attached Local\'s key and the site user uses password authentication. Stored encrypted with your system keychain.',
						}, h(TextInput, { value: password, onChange: setPassword, type: 'password' }))
						: null)
				: null,
			h(BusyNote, { busy: action.busy && choices !== null }, progress || 'Linking…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'SPConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !usable || !canSubmit,
					onClick: () => action.run(() => onSubmit({
						kind: 'account',
						id: choice.id,
						...(password ? { password } : {}),
						progressId: start(),
					})),
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadSites }, 'Refresh list')));
	}

	/**
	 * SSH details typed in by hand (the server's IP address and the site user), for sites the API token can't see.
	 * `onSubmit({ kind: 'manual', host, port, username, authType, password, remotePath, domain, progressId })`.
	 */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: '', port: DEFAULT_SSH_PORT, username: '', authType: 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host.trim() && form.port.trim() && form.username.trim() && (form.authType === 'key' || form.password);

		return h('div', { className: 'SPConnect_Form' },
			h('p', { className: 'SPConnect_Intro' },
				'No API token? Log in as the site\'s site user: the server\'s IP address is on its server page in SpinupWP, and the site user on the site\'s page. ',
				h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'SpinupWP\'s SSH key guide')),
			h('div', { className: 'SPConnect_Row' },
				h(Field, { label: 'Server IP address' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: '203.0.113.10' })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port'), placeholder: DEFAULT_SSH_PORT }))),
			h(Field, { label: 'Site user', help: 'Each SpinupWP site has its own site user, which can only reach that site\'s folder.' }, h(TextInput, { value: form.username, onChange: set('username'), placeholder: 'example' })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'The site user\'s password (the site user must use password authentication in SpinupWP). Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: `Add it in SpinupWP → ${SSH_KEYS_PATH} and attach it to ${SITE_USER_PATH} first.` }, h(PublicKeyBox)),
			h(Field, { label: 'Site domain (optional)', help: 'Finds the site\'s folder (/sites/<domain>/files), is used as its URL if the database has no home URL yet, and replaces the www twin on pull.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(Field, { label: 'Remote path (optional)', help: 'The folder that holds wp-config.php. Detected automatically when left empty.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: '/sites/example.com/files' })),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'SPConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('account');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['account', 'SpinupWP API'], ['manual', 'SSH details']] }),
			mode === 'account' ? h(AccountSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'SPConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'SPConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'SPConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'SPConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'SPConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'SPConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => ({ kind, ...source }) => (kind === 'account'
		? ipcAsync(IPC.LINK_ACCOUNT_SITE, { siteId, ...source })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function SpinupWPPanel({ site }) {
		const [state] = useSpinupWPState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'SPConnect' },
			h(Title, { size: 'm', className: 'SPConnect_Title' }, 'SpinupWP'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on SpinupWP'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on SpinupWP', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'SPConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'SPConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'SPConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `SpinupWP: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `SPConnect_Badge SPConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'SPConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and SpinupWP, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on SpinupWP' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to SpinupWP' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'SPConnect_Compare' },
			h('p', { className: 'SPConnect_Intro' },
				'See which files differ between Local and SpinupWP, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'SPConnect_Actions SPConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with SpinupWP'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'SPConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and SpinupWP have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'SPConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'SPConnect_Group' },
									h('label', { className: 'SPConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'SPConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'SPConnect_Actions SPConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from SpinupWP" option. */
	function NewSitePage({ history }) {
		const [state] = useSpinupWPState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onSiteSelected = (choice) => {
			if (!nameTouched) setSiteName(choiceName(choice));
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'SPConnect SPConnect_NewSite' },
			h('div', { className: 'SPConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'SPConnect_Title' }, 'Pull from SpinupWP')),
			h('p', { className: 'SPConnect_Intro' },
				'Creates a new Local site, then pulls the files and database of a SpinupWP site into it. Your SpinupWP site is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'SPConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the SpinupWP site\'s name.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My SpinupWP site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onSiteSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = useSpinupWPState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'SPConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${linkTarget(link)})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'SPConnect_HeaderButtons' },
			h('span', { className: 'SPConnect_HeaderLabel' }, 'SpinupWP'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'SPConnect SPConnect_Modal' },
						h(Title, { size: 'l', className: 'SPConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'SPConnect_Intro' }, open === 'push'
							? `${site.name} → ${linkTarget(link)}`
							: `${linkTarget(link)} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { SpinupWPPanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
