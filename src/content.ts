// Content script entry. Runs on Strava activity-list and individual activity
// pages in the page's isolated world but with same-origin fetch capability -
// that's the magic that lets us call Strava's photo URLs and any backing JSON
// endpoints without any cookie wrangling.
//
// Two mount points, picked per page:
//
//   - List mode (`/athlete/training*`): the toolbar mounts above the
//     activities table with Select-all-visible, Include videos, Download
//     photos, count, and status. Every row gets a checkbox and a per-row
//     Photos button. Strava reflows the table on every search / sort /
//     pagination; a MutationObserver re-runs the idempotent injection.
//
//   - Single-activity mode (`/activities/<id>*`): a slimmer toolbar
//     mounts at the bottom of `#activity-photos-container` - Include
//     videos, Download photos, status. No row UI - the activity is
//     implicitly the one selected.
//
// Both modes share the same status line, run-photo-download flow, busy
// interlock, and `STATE.includeVideos` toggle.

import { downloadBulkPhotos } from './photo-downloader.ts';
import { KOFI_IMAGE } from './kofi-asset.ts';
import { t } from './i18n.ts';
import type { ActivityRow, StatusKind } from './types.ts';

const KOFI_URL = 'https://ko-fi.com/D1D51ZGOQK';

/**
 * Escape user-supplied text before embedding it in an innerHTML template.
 * Translated strings come from Chrome's i18n system, which we control, but
 * being defensive keeps a future "wrong message file" pasted by a contributor
 * from breaking out of the attribute it lives in.
 */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

type ToolbarMode = 'list' | 'single';

interface State {
	selected: Set<string>;
	toolbar: HTMLDivElement | null;
	busy: boolean;
	/** Mirrors the "Include videos" toolbar checkbox so per-row clicks honor it too. */
	includeVideos: boolean;
	/**
	 * When mounted on `/activities/<id>`, the activity whose page we're on.
	 * Null in list mode. Read by handleBulkClick to drive the download flow
	 * for the one implicitly selected activity.
	 */
	singleActivity: ActivityRow | null;
	/**
	 * Controller for the in-flight bulk run, or null when idle. Set at the
	 * start of runPhotoDownload, cleared in its finally. The Cancel button
	 * calls `.abort()` on this; downloadBulkPhotos throws an AbortError at
	 * the next safe boundary and the catch surfaces "Cancelled." status.
	 */
	currentRun: AbortController | null;
}

const STATE: State = {
	selected: new Set<string>(),
	toolbar: null,
	busy: false,
	includeVideos: false,
	singleActivity: null,
	currentRun: null,
};

// ---------- DOM discovery ----------

/** Find the activities table by looking for any table that links to /activities/N. */
function findActivitiesTable(): HTMLTableElement | null {
	for (const table of document.querySelectorAll<HTMLTableElement>('table')) {
		if (table.querySelector('a[href*="/activities/"]')) return table;
	}
	return null;
}

/** Pull { id, name, sport_type } from a rendered table row, or null. */
function activityFromRow(row: HTMLTableRowElement): ActivityRow | null {
	const link = row.querySelector<HTMLAnchorElement>('a[href*="/activities/"]');
	if (!link) return null;
	const href = link.getAttribute('href');
	if (!href) return null;
	const m = /\/activities\/(\d+)/.exec(href);
	if (!m?.[1]) return null;
	const id = m[1];
	const name = (link.textContent ?? '').trim() || `Activity ${id}`;
	// Sport is usually the first <td> in the row. Best-effort, fine if missing.
	const sportCell = row.querySelector('td');
	const sport_type = sportCell ? (sportCell.textContent ?? '').trim() : '';
	return { id, name, sport_type };
}

/**
 * If we're currently on `/activities/<id>` (or one of its subroutes), build
 * an ActivityRow from the page chrome - id from the URL, name from the
 * activity-name heading, sport from the title-line tail text. Returns null
 * on any other route.
 */
function parseSingleActivityFromPage(): ActivityRow | null {
	const m = /^\/activities\/(\d+)(?:\/|$)/.exec(location.pathname);
	if (!m?.[1]) return null;
	const id = m[1];
	const nameEl =
		document.querySelector<HTMLElement>('h1.activity-name') ?? document.querySelector<HTMLElement>('.activity-name');
	const name = nameEl?.textContent?.trim() ?? `Activity ${id}`;
	// The title span reads `<a>Athlete Name</a> – Sport`. We want just the
	// trailing sport label, so pull text-only child nodes and strip leading
	// dashes / bullets / whitespace.
	let sport_type = '';
	const titleEl = document.querySelector<HTMLElement>('#heading .title');
	if (titleEl) {
		const tail = Array.from(titleEl.childNodes)
			.filter((n): n is Text => n.nodeType === Node.TEXT_NODE)
			.map((n) => (n.textContent ?? '').trim())
			.filter(Boolean)
			.join(' ');
		sport_type = tail.replace(/^[-–—•\s]+/, '').trim();
	}
	return { id, name, sport_type };
}

/**
 * Where to drop the single-activity toolbar. Returns the photos container
 * only when it actually contains media thumbnails, so indoor activities
 * with no photos don't get a toolbar offering nothing to download.
 */
function findSinglePageAnchor(): Element | null {
	const container = document.querySelector('#activity-photos-container');
	if (!container) return null;
	if (!container.querySelector('[data-react-class="MediaThumbnailList"]')) return null;
	return container;
}

// ---------- Per-row injection ----------

/**
 * Build a fresh per-row checkbox input wired to the selection state.
 */
function makeRowCheckbox(a: ActivityRow): HTMLInputElement {
	const cb = document.createElement('input');
	cb.type = 'checkbox';
	cb.className = 'sbpx-row-cb';
	cb.title = t('photoButtonTitle');
	cb.checked = STATE.selected.has(a.id);
	cb.addEventListener('change', () => {
		if (cb.checked) STATE.selected.add(a.id);
		else STATE.selected.delete(a.id);
		onSelectionChanged();
	});
	return cb;
}

/**
 * Build a fresh per-row Photos button wired to the single-activity download.
 */
function makeRowButton(a: ActivityRow): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'sbpx-btn sbpx-btn-primary sbpx-btn-row';
	btn.textContent = t('photoButton');
	btn.title = t('photoButtonTitle');
	btn.addEventListener('click', async (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (btn.disabled || STATE.busy) return;
		btn.disabled = true;
		const old = btn.textContent ?? t('photoButton');
		btn.textContent = '…';
		try {
			await runPhotoDownload([a]);
		} finally {
			btn.disabled = false;
			btn.textContent = old;
		}
	});
	return btn;
}

/**
 * Idempotent per-row injection that reconciles whatever state the row is
 * already in. Four things make this non-trivial:
 *
 *  1. Strava's React occasionally replaces a row's children during a
 *     re-render, which can drop our cells without dropping the row's
 *     `data-sbpx-augmented` flag. We re-add them on the next tick.
 *  2. The Strava Bulk GPX extension may load _before_ or _after_ us. If
 *     after, the row first gets our `.sbpx-cell-*` cells; when the GPX
 *     cells appear later, we migrate our controls INTO theirs and remove
 *     our now-redundant cells, so the trailing action column doesn't
 *     gain two parallel columns.
 *  3. The same applies to the checkbox cell at the front of the row.
 *  4. Strava renders an inline edit form inside `<td class="edit-col">`
 *     that contains a NESTED `<table>` with its own `<tr>` and `<td>`s.
 *     A naive `row.querySelector('.sbgx-cell-dl')` returns the first match
 *     in DOM order, which often lands inside that nested row (the edit-col
 *     cell appears before the outer row's trailing action cell). Same hazard
 *     for `'tbody tr'` selectors at table level - they match the nested
 *     `<tr>` too. Every selector below is therefore pinned with `:scope >`
 *     so it only sees the row's own direct cells; iteration is similarly
 *     pinned at the table level. Without this, the Photos button would be
 *     injected into the hidden edit-form row and never appear on-screen.
 *
 * Splitting the checkbox and button into their own reconcile helpers keeps
 * each step straightforward: check what's already there, migrate if needed,
 * create from scratch if not.
 */
function reconcileCheckbox(row: HTMLTableRowElement, a: ActivityRow): void {
	// `:scope >` confines the lookup to this row's direct children, dodging
	// the nested edit-col tr (see the `(4)` note above).
	const sbgxCheck = row.querySelector<HTMLTableCellElement>(':scope > td.sbgx-cell-check');
	const ownCheck = row.querySelector<HTMLTableCellElement>(':scope > td.sbpx-cell-check');
	let cb: HTMLInputElement | null = null;
	if (sbgxCheck) cb = sbgxCheck.querySelector<HTMLInputElement>('.sbpx-row-cb');
	if (!cb && ownCheck) cb = ownCheck.querySelector<HTMLInputElement>('.sbpx-row-cb');

	if (cb && sbgxCheck && !sbgxCheck.contains(cb)) {
		// GPX has appeared after we created our own cell - move our
		// checkbox into theirs and drop our now-orphan cell.
		cb.classList.add('sbpx-row-cb-coexisting');
		sbgxCheck.appendChild(cb);
		ownCheck?.remove();
		return;
	}

	if (!cb) {
		cb = makeRowCheckbox(a);
		if (sbgxCheck) {
			cb.classList.add('sbpx-row-cb-coexisting');
			sbgxCheck.appendChild(cb);
		} else {
			const cell = document.createElement('td');
			cell.className = 'sbpx-cell sbpx-cell-check';
			cell.appendChild(cb);
			row.insertBefore(cell, row.firstChild);
		}
	}
}

function reconcileButton(row: HTMLTableRowElement, a: ActivityRow): void {
	const sbgxDl = row.querySelector<HTMLTableCellElement>(':scope > td.sbgx-cell-dl');
	const ownDl = row.querySelector<HTMLTableCellElement>(':scope > td.sbpx-cell-dl');
	let btn: HTMLButtonElement | null = null;
	if (sbgxDl) btn = sbgxDl.querySelector<HTMLButtonElement>('.sbpx-btn-row');
	if (!btn && ownDl) btn = ownDl.querySelector<HTMLButtonElement>('.sbpx-btn-row');

	if (btn && sbgxDl && !sbgxDl.contains(btn)) {
		btn.classList.add('sbpx-btn-row-coexisting');
		sbgxDl.appendChild(btn);
		ownDl?.remove();
		return;
	}

	if (!btn) {
		btn = makeRowButton(a);
		if (sbgxDl) {
			btn.classList.add('sbpx-btn-row-coexisting');
			sbgxDl.appendChild(btn);
		} else {
			const cell = document.createElement('td');
			cell.className = 'sbpx-cell sbpx-cell-dl';
			cell.appendChild(btn);
			row.appendChild(cell);
		}
	}
}

function injectRow(row: HTMLTableRowElement): void {
	const a = activityFromRow(row);
	if (!a) return;
	// Keep the selection-state id in sync. Set regardless of augmentation
	// state - cheap and stays correct if Strava ever swaps the underlying
	// `<a href>` (it shouldn't, but defense in depth).
	row.dataset.sbpxId = a.id;
	reconcileCheckbox(row, a);
	reconcileButton(row, a);
	row.dataset.sbpxAugmented = '1';
}

function injectAllRows(table: HTMLTableElement): void {
	// `:scope >` keeps us on the activities-table tbody and skips the nested
	// `<table>` Strava renders inside each row's hidden `<td class="edit-col">`
	// inline edit form - those nested rows are not real activities and must
	// not collect Photos UI.
	table.querySelectorAll<HTMLTableRowElement>(':scope > tbody > tr').forEach(injectRow);
}

// ---------- Toolbar ----------

/**
 * Build the toolbar element. `mode` controls which controls are rendered:
 *   - 'list'   - includes Select-all, count, and disabled-until-selected
 *                bulk button. Used above the activities table.
 *   - 'single' - omits Select-all and count; the bulk button starts enabled
 *                because the activity is implicitly selected. Used at the
 *                bottom of the photos block on `/activities/<id>`.
 *
 * Both modes share the Include-videos toggle, status line, spacer, and
 * Ko-fi link. They also share the same data-role attributes for status
 * and bulk, so setStatus() and the bulk click handler don't care which
 * mode they're operating on.
 */
function buildToolbar(mode: ToolbarMode): HTMLDivElement {
	const toolbar = document.createElement('div');
	toolbar.className = `sbpx-toolbar sbpx-toolbar-${mode}`;
	toolbar.dataset.sbpxMode = mode;
	const koFiLabel = escapeHtml(t('koFiTitle'));
	const selectAllHtml =
		mode === 'list'
			? `<label class="sbpx-tool sbpx-select-all">
        <input type="checkbox" class="sbpx-select-all-cb" />
        <span>${escapeHtml(t('selectAllVisible'))}</span>
      </label>`
			: '';
	const includeVideosHtml = `<label class="sbpx-tool sbpx-include-videos">
        <input type="checkbox" class="sbpx-include-videos-cb" data-role="include-videos" />
        <span>${escapeHtml(t('includeVideos'))}</span>
      </label>`;
	const bulkBtnHtml = `<button class="sbpx-btn sbpx-btn-primary" data-role="bulk" ${
		mode === 'list' ? 'disabled' : ''
	}>${escapeHtml(t('downloadSelected'))}</button>`;
	// Cancel sits directly next to the bulk button so the relationship is
	// obvious. Hidden until STATE.busy turns on (see renderToolbarCounts).
	const cancelBtnHtml = `<button class="sbpx-btn sbpx-btn-cancel" data-role="cancel" hidden>${escapeHtml(t('cancel'))}</button>`;
	const countHtml =
		mode === 'list'
			? `<span class="sbpx-tool sbpx-count" data-role="count">${escapeHtml(t('selectedCount', '0'))}</span>`
			: '';
	// Order matters and differs by mode:
	//   list   - select-all, include-videos, bulk btn, count, status, spacer, kofi
	//             Status sits inline next to count - the list-page toolbar
	//             spans the full width of the activities table, so there
	//             is plenty of room and a single dense row reads cleaner
	//             than reserving a second row for the message.
	//   single - bulk btn, include-videos, spacer, status
	//             Status is the LAST child here so that
	//             `.sbpx-toolbar-single { flex-wrap: wrap }` +
	//             `flex-basis: 100%` drops it onto a new row beneath the
	//             controls. The single-activity container is narrower than
	//             the list-page one; a long "Saved 12 photos…" would
	//             otherwise crowd the button row and get clipped by ellipsis.
	//             Note: ko-fi is intentionally OMITTED here. List mode
	//             stretches across the whole activities-table width, so the
	//             support button has room; the single-activity toolbar sits
	//             inside a much narrower photos container and would feel
	//             cluttered with a "Buy me a coffee" pill next to the action button.
	// The single-mode flip also puts the primary action first (where the
	// eye goes) and reduces the visual cost of the optional "Include videos"
	// toggle on what is fundamentally a one-click flow.
	// The progress bar sits between the spinner and the status text so the
	// fill grows leftward-to-rightward right next to "Downloading 12 / 47…".
	// `data-role="progress"` is the container; the inner bar's width is
	// what setProgress() animates. Both start hidden; runPhotoDownload()
	// shows them once a discovering / downloading event arrives, and the
	// finally block hides them on terminal state.
	const statusHtml = `<span class="sbpx-tool sbpx-status" data-role="status">
        <span class="sbpx-spinner" data-role="spinner" hidden></span>
        <span class="sbpx-progress" data-role="progress" hidden>
          <span class="sbpx-progress-bar" data-role="progress-bar"></span>
        </span>
        <span class="sbpx-status-text" data-role="status-text"></span>
      </span>`;
	const spacerHtml = '<span class="sbpx-spacer"></span>';
	const kofiHtml = `<a class="sbpx-kofi" href="${KOFI_URL}" target="_blank" rel="noopener" title="${koFiLabel}">
        <img src="${KOFI_IMAGE}" alt="${koFiLabel}" />
      </a>`;
	toolbar.innerHTML =
		mode === 'list'
			? `${selectAllHtml}${includeVideosHtml}${bulkBtnHtml}${cancelBtnHtml}${countHtml}${statusHtml}${spacerHtml}${kofiHtml}`
			: `${bulkBtnHtml}${cancelBtnHtml}${includeVideosHtml}${spacerHtml}${statusHtml}`;

	const selectAll = toolbar.querySelector<HTMLInputElement>('.sbpx-select-all-cb');
	if (selectAll) {
		selectAll.addEventListener('change', () => {
			const want = selectAll.checked;
			for (const cb of document.querySelectorAll<HTMLInputElement>('.sbpx-row-cb')) {
				const id = cb.closest<HTMLTableRowElement>('tr')?.dataset.sbpxId;
				if (!id) continue;
				cb.checked = want;
				if (want) STATE.selected.add(id);
				else STATE.selected.delete(id);
			}
			onSelectionChanged();
		});
	}

	const includeVideosCb = toolbar.querySelector<HTMLInputElement>('[data-role="include-videos"]')!;
	includeVideosCb.checked = STATE.includeVideos;
	includeVideosCb.addEventListener('change', () => {
		STATE.includeVideos = includeVideosCb.checked;
		// Clear any leftover terminal status so it doesn't read wrong for
		// the new mode (e.g. "Saved N photos" lingering after the user
		// just ticked "Include videos").
		if (!STATE.busy) setStatus('');
	});

	const bulkBtn = toolbar.querySelector<HTMLButtonElement>('[data-role="bulk"]')!;
	bulkBtn.addEventListener('click', handleBulkClick);

	const cancelBtn = toolbar.querySelector<HTMLButtonElement>('[data-role="cancel"]')!;
	cancelBtn.addEventListener('click', () => {
		// abort() on the run controller; downloadBulkPhotos throws an
		// AbortError at the next safe boundary. The button stays visible
		// until renderToolbarCounts() flips it back on STATE.busy → false.
		STATE.currentRun?.abort();
	});

	return toolbar;
}

/**
 * Make sure a toolbar exists for the current page mode. If we already have
 * a toolbar mounted in the wrong mode, tear it down first, so we build a
 * fresh one matching the new page.
 */
function ensureToolbarForMode(mode: ToolbarMode): HTMLDivElement | null {
	if (STATE.toolbar) {
		if (!document.contains(STATE.toolbar)) {
			STATE.toolbar = null;
		} else if (STATE.toolbar.dataset.sbpxMode !== mode) {
			STATE.toolbar.remove();
			STATE.toolbar = null;
		}
	}
	if (STATE.toolbar) return STATE.toolbar;
	return null;
}

function ensureListToolbar(table: HTMLTableElement): HTMLDivElement | null {
	const existing = ensureToolbarForMode('list');
	if (existing) return existing;
	const parent = table.parentElement;
	if (!parent) return null;
	const tb = buildToolbar('list');
	parent.insertBefore(tb, table);
	STATE.toolbar = tb;
	return tb;
}

function ensureSingleToolbar(activity: ActivityRow, anchor: Element): HTMLDivElement | null {
	STATE.singleActivity = activity;
	const existing = ensureToolbarForMode('single');
	if (existing) return existing;
	const tb = buildToolbar('single');
	// Append at the end of the photos container so the toolbar sits just
	// under the thumbnail strip with the same horizontal alignment.
	anchor.appendChild(tb);
	STATE.toolbar = tb;
	return tb;
}

/**
 * Hide the Ko-fi badge on our toolbar when the Strava Bulk GPX extension
 * is also mounted on the page. Both extensions inject a "Buy me a coffee"
 * pill, and stacking two identical badges, one toolbar above the other
 * reads as a duplicate ask. GPX is the sister project; its badge is the
 * canonical one on shared pages, so we suppress ours while it's present.
 *
 * Re-evaluated on every tick() because the GPX content script can load
 * later than ours (the order is not deterministic between user-installed
 * extensions). The DOM check is dirt cheap - a single querySelector on
 * the body - so running it every tick is fine.
 */
function syncKofiVisibility(): void {
	if (!STATE.toolbar) return;
	const kofi = STATE.toolbar.querySelector<HTMLAnchorElement>('.sbpx-kofi');
	if (!kofi) return;
	const gpxToolbar = document.querySelector('.sbgx-toolbar');
	kofi.hidden = gpxToolbar !== null;
}

function renderToolbarCounts(): void {
	if (!STATE.toolbar) return;
	const bulkBtn = STATE.toolbar.querySelector<HTMLButtonElement>('[data-role="bulk"]')!;
	const cancelBtn = STATE.toolbar.querySelector<HTMLButtonElement>('[data-role="cancel"]')!;
	// Cancel is busy-driven in both modes - the relationship is the same
	// regardless of whether the toolbar tracks a selection or an implicit
	// activity. Hidden when idle; revealed while a run is in flight.
	cancelBtn.hidden = !STATE.busy;
	if (STATE.toolbar.dataset.sbpxMode === 'single') {
		// Single-activity mode: bulk is always available, just gated on busy.
		// No select-all / count to keep in sync.
		bulkBtn.disabled = STATE.busy;
		return;
	}

	const selectableIds = new Set<string>();
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbpx-id]')) {
		const id = row.dataset.sbpxId;
		if (id) selectableIds.add(id);
	}
	let visibleSelected = 0;
	for (const id of STATE.selected) if (selectableIds.has(id)) visibleSelected++;

	const countEl = STATE.toolbar.querySelector<HTMLElement>('[data-role="count"]')!;
	countEl.textContent = t('selectedCount', String(visibleSelected));
	bulkBtn.disabled = visibleSelected === 0 || STATE.busy;

	const allCb = STATE.toolbar.querySelector<HTMLInputElement>('.sbpx-select-all-cb')!;
	if (selectableIds.size === 0) {
		allCb.checked = false;
		allCb.indeterminate = false;
	} else {
		allCb.checked = visibleSelected === selectableIds.size;
		allCb.indeterminate = visibleSelected > 0 && visibleSelected < selectableIds.size;
	}
}

/**
 * Update the toolbar status line.
 *
 * @param text     What to display. Pass "" to clear.
 * @param kind     Drives color (info | ok | warn | err).
 * @param spinner  Show the inline spinner; always false when terminal.
 */
function setStatus(text: string, kind: StatusKind = '', { spinner = false }: { spinner?: boolean } = {}): void {
	if (!STATE.toolbar) return;
	const container = STATE.toolbar.querySelector<HTMLElement>('[data-role="status"]')!;
	const textEl = container.querySelector<HTMLElement>('[data-role="status-text"]')!;
	const spinnerEl = container.querySelector<HTMLElement>('[data-role="spinner"]')!;
	textEl.textContent = text;
	container.dataset.kind = kind;
	spinnerEl.hidden = !spinner;
}

/**
 * Update the toolbar progress bar.
 *
 * @param fraction  0..1 progress. Pass `null` to hide the bar (used for
 *                  indeterminate phases like zipping, and on terminal state).
 */
function setProgress(fraction: number | null): void {
	if (!STATE.toolbar) return;
	const container = STATE.toolbar.querySelector<HTMLElement>('[data-role="progress"]')!;
	if (fraction === null) {
		container.hidden = true;
		return;
	}
	const bar = container.querySelector<HTMLElement>('[data-role="progress-bar"]')!;
	const clamped = Math.max(0, Math.min(1, fraction));
	bar.style.width = `${(clamped * 100).toFixed(1)}%`;
	container.hidden = false;
}

/**
 * Reflect STATE.selected onto every rendered checkbox. Important when two
 * rows share an id (sticky header mirror, etc.) - without this, checking one
 * would leave the duplicate visibly unchecked.
 */
function syncRowCheckboxes(): void {
	for (const cb of document.querySelectorAll<HTMLInputElement>('.sbpx-row-cb')) {
		const id = cb.closest<HTMLTableRowElement>('tr')?.dataset.sbpxId;
		if (id) cb.checked = STATE.selected.has(id);
	}
}

/**
 * User-initiated selection change. Clears any leftover post-download status
 * (e.g. "Saved N photos from M activities.") so the toolbar reflects only
 * the current intent, but leaves in-progress download messages alone.
 */
function onSelectionChanged(): void {
	syncRowCheckboxes();
	if (!STATE.busy) setStatus('');
	renderToolbarCounts();
}

/**
 * Build the activity list from currently visible rows that are in the
 * selected set. Dedupes by activity id - Strava sometimes renders more than
 * one <tr> per activity (sticky header mirror, transient rows during
 * pagination), and both would otherwise inflate the count.
 */
function collectSelectedActivities(): ActivityRow[] {
	const seen = new Set<string>();
	const activities: ActivityRow[] = [];
	for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-sbpx-id]')) {
		const id = row.dataset.sbpxId;
		if (!id || !STATE.selected.has(id) || seen.has(id)) continue;
		seen.add(id);
		const a = activityFromRow(row);
		if (a) activities.push(a);
	}
	return activities;
}

/**
 * Shared download flow for both the per-row "Photos" button and the toolbar
 * "Download photos" button. Drives the toolbar status line through each
 * stage and lands on the right terminal copy.
 *
 * STATE.busy is the cross-handler interlock - while one run is in flight,
 * neither the bulk button nor any per-row button will accept a click.
 */
async function runPhotoDownload(activities: ActivityRow[]): Promise<void> {
	if (activities.length === 0) return;
	const includeVideos = STATE.includeVideos;
	const controller = new AbortController();
	STATE.busy = true;
	STATE.currentRun = controller;
	renderToolbarCounts();
	setStatus(t('preparingDownloads', String(activities.length)), 'info', { spinner: true });
	try {
		const result = await downloadBulkPhotos(activities, {
			includeVideos,
			signal: controller.signal,
			onProgress: (ev) => {
				if (ev.stage === 'discovering') {
					setStatus(t('preparingDownloads', String(ev.total)), 'info', { spinner: true });
					setProgress(ev.total > 0 ? ev.completed / ev.total : null);
				} else if (ev.stage === 'downloading') {
					// Use the more general "items" copy when videos may be in the mix.
					const key = includeVideos ? 'downloadingProgressMedia' : 'downloadingProgress';
					setStatus(t(key, [String(ev.completed), String(ev.total)]), 'info', { spinner: true });
					setProgress(ev.total > 0 ? ev.completed / ev.total : null);
				} else if (ev.stage === 'zipping') {
					setStatus(t('buildingZip'), 'info', { spinner: true });
					// Zipping is indeterminate - drop the bar back to the spinner-only state.
					setProgress(null);
				}
			},
		});
		if (result.ok === 0 && result.failed.length === 0) {
			setStatus(t(includeVideos ? 'noMediaFound' : 'noPhotosFound'), 'warn');
		} else {
			const firstFailed = result.failed[0];
			if (firstFailed) {
				setStatus(t('savedWithSkips', [String(result.ok), String(result.failed.length), firstFailed.reason]), 'warn');
			} else if (includeVideos && result.videos > 0) {
				setStatus(t('savedMedia', [String(result.photos), String(result.videos), String(result.activities)]), 'ok');
			} else {
				// Either includeVideos was off OR no videos turned up - use the photos-only copy.
				setStatus(t('savedPhotos', [String(result.photos), String(result.activities)]), 'ok');
			}
		}
	} catch (err) {
		// AbortError is the user's own Cancel click - showing message with text "Cancelled."
		if ((err as Error)?.name === 'AbortError') {
			setStatus(t('cancelled'), 'warn');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			setStatus(t('downloadFailed', message), 'err');
		}
	} finally {
		STATE.busy = false;
		STATE.currentRun = null;
		setProgress(null);
		renderToolbarCounts();
	}
}

async function handleBulkClick(): Promise<void> {
	if (STATE.busy) return;
	// In single-activity mode, the bulk button operates on the implicitly
	// selected activity attached to the current page; in list mode, it
	// operates on whatever rows the user has checked.
	const activities = STATE.singleActivity ? [STATE.singleActivity] : collectSelectedActivities();
	await runPhotoDownload(activities);
}

// ---------- Boot + observer ----------

function tick(): void {
	// Prefer the single-activity flow when we're on `/activities/<id>` AND
	// the page has photo thumbnails. Falls through to list mode (or no-op)
	// otherwise.
	const singleActivity = parseSingleActivityFromPage();
	const singleAnchor = singleActivity ? findSinglePageAnchor() : null;
	if (singleActivity && singleAnchor) {
		ensureSingleToolbar(singleActivity, singleAnchor);
		renderToolbarCounts();
		return;
	}

	const table = findActivitiesTable();
	if (!table) return;
	STATE.singleActivity = null;
	ensureListToolbar(table);
	injectAllRows(table);
	syncKofiVisibility();
	renderToolbarCounts();
}

/**
 * Run `tick()` at most once per debounce window, suppressing both rapid
 * bursts (Strava's React re-rendering 100 rows in one frame) and re-entrant
 * fires triggered by our own injection. When the user has another Strava
 * extension active (notably Strava Bulk GPX, which shares the activities
 * table with us), the cross-talk between the two extensions' observers used
 * to drive `tick()` once per frame indefinitely - tightening the schedule
 * here is the cheap, local fix.
 */
const OBSERVER_DEBOUNCE_MS = 100;
let scheduledTick: ReturnType<typeof setTimeout> | null = null;
let mutatingSelf = 0;

function scheduleTick(): void {
	if (scheduledTick !== null) return;
	scheduledTick = setTimeout(() => {
		scheduledTick = null;
		// Increment around tick() so any DOM writes the injection helpers
		// make won't re-trigger the observer's queue.
		mutatingSelf++;
		try {
			tick();
		} finally {
			mutatingSelf--;
		}
	}, OBSERVER_DEBOUNCE_MS);
}

function start(): void {
	// Initial mount: paint the toolbar + per-row controls before the user
	// gets a chance to interact.
	mutatingSelf++;
	try {
		tick();
	} finally {
		mutatingSelf--;
	}

	// Strava's React reflows the table on every search / sort / pagination.
	// A single observer on the body handles all of it; the injection helpers
	// are idempotent. The two safeguards that actually matter for perf are
	// the 100 ms debounce in scheduleTick() and the `mutatingSelf` guard
	// below; an earlier version of this observer also tried to filter
	// mutation records by inspecting `record.target.closest('table')`, but
	// that mishandled the very first re-render (Strava appends the <table>
	// to a <div> - closest() walks UP from the div, never finds the table)
	// and dropped the mutations that would inject our row buttons. Drop the
	// filter; the debounce alone keeps the tick rate sane.
	const obs = new MutationObserver(() => {
		// Drop the batch if we're the ones writing to the DOM. Without
		// this, the very mutations we cause in tick() would re-arm the
		// debounced callback in a loop.
		if (mutatingSelf > 0) return;
		scheduleTick();
	});
	obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
