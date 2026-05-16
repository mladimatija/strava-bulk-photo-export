// E2E behavior tests. Each test starts from a fresh fixture page with the
// content script already mounted (see tests/fixtures/extension.ts).

import { test, expect, SINGLE_FIXTURE_ACTIVITY_ID, type Page } from '../fixtures/extension.ts';

interface CapturedClick {
	href: string;
	download: string | null;
}

declare global {
	interface Window {
		__sbpxClicks?: CapturedClick[];
	}
}

/**
 * Install a capture-phase click listener that records every `<a>` click on
 * the page and suppresses the real default action (navigation / download).
 *
 * Why an event listener instead of monkey-patching `prototype.click`:
 * Chrome extension content scripts run in an isolated JavaScript world with
 * their own copies of every prototype. When our content script (in its own
 * world) calls `a.click()`, it looks up `click` on the *isolated-world*
 * `HTMLAnchorElement.prototype`. A patch installed via `page.evaluate()`
 * runs in the *page world* and never gets hit. DOM events, by contrast,
 * are shared infrastructure - a capture-phase listener on `document` sees
 * clicks dispatched from either world, and `preventDefault` cancels the
 * anchor's default download regardless of where the click originated.
 */
async function installAnchorClickCapture(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.__sbpxClicks = [];
		document.addEventListener(
			'click',
			(e: Event) => {
				const target = e.target;
				if (target instanceof HTMLAnchorElement) {
					window.__sbpxClicks?.push({
						href: target.href,
						download: target.getAttribute('download'),
					});
					e.preventDefault();
					e.stopImmediatePropagation();
				}
			},
			true,
		);
	});
}

/** Read whatever {@link installAnchorClickCapture} captured. */
async function readCapturedAnchorClicks(page: Page): Promise<CapturedClick[]> {
	return page.evaluate(() => window.__sbpxClicks ?? []);
}

/**
 * Render a Strava-style activity-page response containing the React-props
 * JSON blob the production discovery code parses. Each `photo` here ends
 * up as one entry; `media_type: 1` is a photo, `media_type: 2` is a video
 * with an HLS master URL.
 */
interface FixturePhoto {
	id: string | number;
	largeUrl: string;
	thumbUrl?: string;
	lat?: number;
	lng?: number;
	caption?: string;
}
interface FixtureVideo {
	id: string | number;
	m3u8Url: string;
	thumbUrl?: string;
	lat?: number;
	lng?: number;
	caption?: string;
}
function activityPageHtml(activityId: string, items: { photos?: FixturePhoto[]; videos?: FixtureVideo[] }): string {
	const photoObjs = (items.photos ?? []).map((p) => ({
		photo_id: String(p.id),
		id: p.id,
		media_type: 1,
		activity_id: activityId,
		thumbnail: p.thumbUrl ?? p.largeUrl,
		large: p.largeUrl,
		video: null,
		lat: p.lat ?? null,
		lng: p.lng ?? null,
		caption_escaped: p.caption ?? '',
		dimensions: { large: { width: 2048, height: 1536 }, thumbnail: { width: 2048, height: 1536 } },
	}));
	const videoObjs = (items.videos ?? []).map((v) => ({
		photo_id: String(v.id),
		id: v.id,
		media_type: 2,
		activity_id: activityId,
		thumbnail: v.thumbUrl ?? '',
		large: v.thumbUrl ?? '',
		video: v.m3u8Url,
		duration: 10,
		lat: v.lat ?? null,
		lng: v.lng ?? null,
		caption_escaped: v.caption ?? '',
		dimensions: { large: { width: 1080, height: 1920 }, thumbnail: { width: 1080, height: 1920 } },
	}));
	const reactProps = {
		photos: [...photoObjs, ...videoObjs],
		viewableCount: photoObjs.length + videoObjs.length,
		category: 'activity_detail',
	};
	// HTML-encode the JSON the same way Strava does (quote characters become &quot;).
	const propsAttr = JSON.stringify(reactProps).replace(/"/g, '&quot;');
	return `<!doctype html><html><head><title>Photos | Strava</title></head><body>
<div data-react-class="PhotoGallery" data-react-props="${propsAttr}"></div>
</body></html>`;
}

test.describe('Strava Bulk Photo Export extension', () => {
	test('mounts the toolbar above the activities table', async ({ extensionPage }) => {
		const toolbar = extensionPage.locator('.sbpx-toolbar');
		await expect(toolbar).toBeVisible();
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeDisabled();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
		await expect(extensionPage.locator('[data-role="bulk"]')).toHaveText('Download photos');
		// New: Include videos checkbox is present and starts unchecked.
		await expect(extensionPage.locator('[data-role="include-videos"]')).toBeVisible();
		await expect(extensionPage.locator('[data-role="include-videos"]')).not.toBeChecked();
		// Ko-fi pill lives on the list page (counterpart to the
		// "Ko-fi badge is omitted on single-activity toolbar" assertion).
		await expect(extensionPage.locator('.sbpx-toolbar-list .sbpx-kofi')).toHaveCount(1);
	});

	test('injects checkbox + Photos button on every row', async ({ extensionPage }) => {
		const rows = extensionPage.locator('tr[data-sbpx-id]');
		await expect(rows).toHaveCount(5);
		await expect(extensionPage.locator('.sbpx-row-cb')).toHaveCount(5);
		await expect(extensionPage.locator('.sbpx-btn-row')).toHaveCount(5);
		await expect(extensionPage.locator('.sbpx-btn-row').first()).toHaveText('Photos');
	});

	test('augments rows that appear after the initial mount (post-render React row)', async ({ extensionPage }) => {
		// Strava's React re-renders the activities table on every search /
		// sort / pagination change, so the content script must react to
		// rows that appear after mount. Earlier the MutationObserver had
		// a too-clever filter on `record.target.closest('table')` that
		// silently dropped the very mutations that added new rows, leaving
		// them un-augmented. This pins the behaviour: drop a brand-new row
		// into the table and assert the Photos button shows up on it.
		await extensionPage.evaluate(() => {
			const tbody = document.querySelector('tbody');
			if (!tbody) return;
			const row = document.createElement('tr');
			row.innerHTML = `
				<td>Trail Run</td>
				<td>Mon, 17/05/2026</td>
				<td><a href="/activities/9000000999">Newly rendered row</a></td>
				<td>1:00:00</td>
				<td>10.00 km</td>
				<td>50 m</td>
				<td>5</td>
				<td></td>
			`;
			tbody.appendChild(row);
		});

		// 100 ms observer debounce + a frame of slack.
		await extensionPage.waitForTimeout(250);

		const row = extensionPage.locator('tr[data-sbpx-id="9000000999"]');
		await expect(row).toHaveCount(1);
		await expect(row.locator('.sbpx-cell-check input.sbpx-row-cb')).toHaveCount(1);
		await expect(row.locator('.sbpx-cell-dl button.sbpx-btn-row')).toHaveText('Photos');
	});

	test('migrates into GPX cells when the GPX extension loads after photo-export', async ({ extensionPage }) => {
		// Race scenario: photo-export wins the document_idle race and
		// injects its own .sbpx-cell-check + .sbpx-cell-dl cells before the
		// GPX extension touches the row. When GPX subsequently injects its
		// .sbgx-cell-* cells, photo-export's observer fires again and
		// `injectRow` should reconcile by moving our checkbox and Photos
		// button INTO the GPX cells, then deleting our now-redundant cells.
		// Without this the Photos button stays in the parallel column and
		// either overlaps with GPX's button or gets removed by GPX's row
		// mutator - which is what the user saw on real Strava.

		// First row: photo-export's own initial mount augmented it with
		// .sbpx-cell-check / .sbpx-cell-dl. Confirm that's where things are.
		const firstRow = extensionPage.locator('tr[data-sbpx-id]').first();
		await expect(firstRow.locator('td.sbpx-cell-check input.sbpx-row-cb')).toHaveCount(1);
		await expect(firstRow.locator('td.sbpx-cell-dl button.sbpx-btn-row')).toHaveCount(1);

		// Simulate GPX waking up _after_ photo-export and adding its cells
		// to the row that photo-export already augmented.
		await extensionPage.evaluate(() => {
			const row = document.querySelector<HTMLTableRowElement>('tr[data-sbpx-id]');
			if (!row) return;
			const checkCell = document.createElement('td');
			checkCell.className = 'sbgx-cell sbgx-cell-check';
			checkCell.innerHTML = '<input type="checkbox" class="sbgx-row-cb">';
			row.insertBefore(checkCell, row.firstChild);
			const dlCell = document.createElement('td');
			dlCell.className = 'sbgx-cell sbgx-cell-dl';
			dlCell.innerHTML = '<button class="sbgx-btn sbgx-btn-primary sbgx-btn-row">GPX</button>';
			row.appendChild(dlCell);
		});

		// 100 ms observer debounce + a frame.
		await extensionPage.waitForTimeout(250);

		// The reconciler should have migrated our checkbox + button into
		// the sbgx cells, and removed our now-orphan cells.
		await expect(firstRow.locator('td.sbpx-cell-check')).toHaveCount(0);
		await expect(firstRow.locator('td.sbpx-cell-dl')).toHaveCount(0);
		await expect(firstRow.locator('.sbgx-cell-check input.sbpx-row-cb.sbpx-row-cb-coexisting')).toHaveCount(1);
		await expect(firstRow.locator('.sbgx-cell-dl button.sbpx-btn-row.sbpx-btn-row-coexisting')).toHaveCount(1);
	});

	test('coexists with the Strava Bulk GPX extension on shared rows', async ({ extensionPage }) => {
		// Simulate a row the GPX extension has already augmented with its
		// own checkbox cell + action cell. Photo-export's injectRow should
		// detect those `sbgx-*` cells and slot the Photos button and our
		// checkbox INTO them instead of appending two more columns to the
		// row. Without this the row trailing column would get the sbgx
		// and sbpx cells crammed side-by-side and visually overlap.
		await extensionPage.evaluate(() => {
			const tbody = document.querySelector('tbody');
			if (!tbody) return;
			const row = document.createElement('tr');
			row.innerHTML = `
				<td class="sbgx-cell sbgx-cell-check"><input type="checkbox" class="sbgx-row-cb"></td>
				<td>Run</td>
				<td>Wed, 14/05/2026</td>
				<td><a href="/activities/9000000009">Mock GPX-augmented run</a></td>
				<td>1:00:00</td>
				<td>10.00 km</td>
				<td>50 m</td>
				<td>10</td>
				<td class="sbgx-cell sbgx-cell-dl"><button class="sbgx-btn sbgx-btn-primary sbgx-btn-row">GPX</button></td>
			`;
			tbody.appendChild(row);
		});

		// The content script's MutationObserver is debounced at 100ms. Give
		// it room to run plus a frame of slack.
		await extensionPage.waitForTimeout(250);

		const row = extensionPage.locator('tr[data-sbpx-id="9000000009"]');
		await expect(row).toHaveCount(1);

		// Photo-export must NOT have added its own `.sbpx-cell-check` or
		// `.sbpx-cell-dl` td: the sbgx ones are already there and we re-use
		// them.
		await expect(row.locator('td.sbpx-cell-check')).toHaveCount(0);
		await expect(row.locator('td.sbpx-cell-dl')).toHaveCount(0);

		// Both checkboxes live inside the single sbgx checkbox cell.
		await expect(row.locator('.sbgx-cell-check input.sbgx-row-cb')).toHaveCount(1);
		await expect(row.locator('.sbgx-cell-check input.sbpx-row-cb.sbpx-row-cb-coexisting')).toHaveCount(1);

		// Both buttons live inside the single sbgx action cell.
		await expect(row.locator('.sbgx-cell-dl button.sbgx-btn-row')).toHaveText('GPX');
		await expect(row.locator('.sbgx-cell-dl button.sbpx-btn-row.sbpx-btn-row-coexisting')).toHaveText('Photos');
	});

	test('Photos button sits at natural cell center when the GPX cell has no GPX button', async ({ extensionPage }) => {
		// GPX adds its trailing `td.sbgx-cell-dl` to every row to keep column
		// alignment, but only renders the GPX button on rows with GPS data.
		// On rows without GPS (workouts, weight training, indoor sessions),
		// the cell is empty and our Photos button sits alone inside it.
		// We deliberately do NOT push Photos down with a synthetic top
		// margin in that case - the natural `vertical-align: middle` puts
		// it at the cell center, lined up with Strava's Share / Edit /
		// Delete actions on the same row. Earlier code padded the top by
		// 24 px to mimic where Photos would sit if a GPX button were
		// stacked above it; that read as misaligned because the actual
		// neighbouring cells (Edit, Delete, Share) are at the row center,
		// not pushed down. This test pins the natural-center behaviour.
		await extensionPage.evaluate(() => {
			const tbody = document.querySelector('tbody');
			if (!tbody) return;
			const row = document.createElement('tr');
			// Note: NO button inside the trailing sbgx-cell-dl. That mimics
			// the empty-cell shape GPX produces on no-GPS rows.
			row.innerHTML = `
				<td class="sbgx-cell sbgx-cell-check"><input type="checkbox" class="sbgx-row-cb"></td>
				<td>Workout</td>
				<td>Fri, 15/05/2026</td>
				<td><a href="/activities/9000000099">Indoor workout (no GPS)</a></td>
				<td>30:00</td>
				<td>0 km</td>
				<td>0 m</td>
				<td>5</td>
				<td class="sbgx-cell sbgx-cell-dl"></td>
			`;
			tbody.appendChild(row);
		});

		// 100 ms observer debounce + a frame.
		await extensionPage.waitForTimeout(250);

		const row = extensionPage.locator('tr[data-sbpx-id="9000000099"]');
		const photosBtn = row.locator(':scope > td.sbgx-cell-dl > button.sbpx-btn-row.sbpx-btn-row-coexisting');
		await expect(photosBtn).toHaveText('Photos');

		// No top margin at all when Photos is alone: the 4 px from the base
		// coexisting rule is only there to space Photos away from a GPX
		// button above it. With nothing above, the gap reads as random
		// padding and pushes Photos off-center relative to the neighbouring
		// Edit / Delete / Share actions.
		const marginTop = await photosBtn.evaluate((el) => getComputedStyle(el).marginTop);
		expect(marginTop).toBe('0px');

		// And on a row WHERE GPX rendered its button, Photos uses the same
		// 4 px gap to stack just below GPX.
		const stackedRow = extensionPage.locator('tr[data-sbpx-id]').first();
		const stackedPhotos = stackedRow.locator(':scope > td.sbgx-cell-dl > button.sbpx-btn-row.sbpx-btn-row-coexisting');
		// First, ensure that row actually has the coexisting layout. Inject
		// a GPX button so this row mimics a GPS-bearing activity.
		await extensionPage.evaluate(() => {
			const first = document.querySelector<HTMLTableRowElement>('tr[data-sbpx-id]');
			if (!first) return;
			// Strip any photo-export-only cells first; we want the GPX
			// extension's column shape.
			first.querySelector('td.sbpx-cell-check')?.remove();
			first.querySelector('td.sbpx-cell-dl')?.remove();
			const cb = document.createElement('td');
			cb.className = 'sbgx-cell sbgx-cell-check';
			cb.innerHTML = '<input type="checkbox" class="sbgx-row-cb">';
			first.insertBefore(cb, first.firstChild);
			const dl = document.createElement('td');
			dl.className = 'sbgx-cell sbgx-cell-dl';
			dl.innerHTML = '<button class="sbgx-btn sbgx-btn-primary sbgx-btn-row">GPX</button>';
			first.appendChild(dl);
		});
		await extensionPage.waitForTimeout(250);
		const stackedMargin = await stackedPhotos.evaluate((el) => getComputedStyle(el).marginTop);
		expect(stackedMargin).toBe('4px');
	});

	test('coexisting Photos button stays right-aligned in a wider GPX cell', async ({ extensionPage }) => {
		// Real Strava's `td.sbgx-cell-dl` is wider than its declared 56 px
		// because GPX renders the cell at content width when a button is
		// inside. Earlier the coexisting Photos button used plain
		// `display: block` which stretched it across the full cell - so the
		// rendered "Photos" label appeared near the cell's LEFT edge,
		// visually beneath whichever Strava action sat at that x (usually
		// the Share dropdown), rather than under GPX at the right edge.
		// The fix constrains the button to `width: fit-content` and pushes
		// it right with `margin-left: auto`. Reproduce the wide-cell shape
		// here and assert the computed style.
		await extensionPage.evaluate(() => {
			const tbody = document.querySelector('tbody');
			if (!tbody) return;
			const row = document.createElement('tr');
			// Force a wider-than-56 px cell with inline style so the test
			// captures the same hazard real Strava exhibits.
			row.innerHTML = `
				<td class="sbgx-cell sbgx-cell-check"><input type="checkbox" class="sbgx-row-cb"></td>
				<td>Run</td>
				<td>Thu, 14/05/2026</td>
				<td><a href="/activities/9000007711">Wide-cell run</a></td>
				<td>1:00:00</td>
				<td>10.00 km</td>
				<td>50 m</td>
				<td>3</td>
				<td class="sbgx-cell sbgx-cell-dl" style="width: 200px;">
					<button class="sbgx-btn sbgx-btn-primary sbgx-btn-row">GPX</button>
				</td>
			`;
			tbody.appendChild(row);
		});
		await extensionPage.waitForTimeout(250);

		const photosBtn = extensionPage.locator(
			'tr[data-sbpx-id="9000007711"] > td.sbgx-cell-dl > button.sbpx-btn-row-coexisting',
		);
		await expect(photosBtn).toHaveText('Photos');

		// Right-edge alignment: the button's right edge should be within a
		// few pixels of the cell's right edge, even though the cell is
		// 200 px wide. Without the `width: fit-content; margin-left: auto`
		// pair, the button would stretch the full 200 px and its right edge
		// would still match - so we additionally assert the button is
		// NARROWER than the cell (which only holds if width is constrained).
		const { btnRight, cellRight, btnWidth, cellWidth } = await photosBtn.evaluate((el) => {
			const cell = el.parentElement as HTMLTableCellElement;
			const b = el.getBoundingClientRect();
			const c = cell.getBoundingClientRect();
			return { btnRight: b.right, cellRight: c.right, btnWidth: b.width, cellWidth: c.width };
		});
		// Right edges within the cell's right padding (`.sbgx-cell` uses 6 px)
		// plus the explicit inline 200 px width's intrinsic padding. The
		// pre-fix layout would have placed the button against the cell's
		// LEFT edge (~150+ px gap), so a 20 px tolerance is plenty to catch
		// any regression while staying robust to browser rounding.
		expect(Math.abs(cellRight - btnRight)).toBeLessThanOrEqual(20);
		// Button is meaningfully narrower than the cell - proves fit-content.
		expect(btnWidth).toBeLessThan(cellWidth - 50);
	});

	test('hides the Ko-fi badge when the GPX extension toolbar is also mounted', async ({ extensionPage }) => {
		// Both photo-export and the sister GPX extension drop a "Buy me a
		// coffee" badge into their toolbars. When both extensions are
		// active, Strava's My Activities page ends up with two stacked
		// toolbars and two identical Ko-fi pills - reads as a duplicate
		// ask. The GPX toolbar is the canonical one; ours suppresses
		// the badge when it detects `.sbgx-toolbar`.
		const kofi = extensionPage.locator('.sbpx-toolbar .sbpx-kofi');

		// Initial state: GPX is not mounted, so our Ko-fi shows.
		await expect(kofi).toBeVisible();

		// Simulate the GPX extension mounting its toolbar somewhere on the
		// page. Inserting it adjacent to ours is the realistic shape -
		// both toolbars normally sit above the activities table.
		await extensionPage.evaluate(() => {
			const tb = document.createElement('div');
			tb.className = 'sbgx-toolbar';
			tb.textContent = 'GPX toolbar (mock)';
			const table = document.querySelector('table');
			if (table?.parentElement) {
				table.parentElement.insertBefore(tb, table);
			}
		});

		// 100 ms observer debounce + a frame.
		await extensionPage.waitForTimeout(250);

		// Now hidden.
		await expect(kofi).toBeHidden();

		// Remove the GPX toolbar - the badge comes back on the next tick.
		await extensionPage.evaluate(() => {
			document.querySelector('.sbgx-toolbar')?.remove();
		});
		await extensionPage.waitForTimeout(250);
		await expect(kofi).toBeVisible();
	});

	test('ignores the nested inline-edit row inside td.edit-col', async ({ extensionPage }) => {
		// Strava renders an inline edit form inside `<td class="edit-col">`
		// on every activity row. That edit form contains a NESTED <table>
		// with its own <tbody> and <tr>, and the GPX extension's broken
		// "tbody tr" iterator drops sbgx-cell-check / sbgx-cell-dl cells
		// into that nested row too. An earlier version of our reconciler
		// used the same loose selectors and ended up routing the Photos
		// button into the hidden nested row - the user saw the button
		// disappear entirely when both extensions were active.
		//
		// This test reproduces that real-world DOM and asserts the Photos
		// button lands in the OUTER row's trailing sbgx-cell-dl, not in
		// the hidden nested one.
		await extensionPage.evaluate(() => {
			const tbody = document.querySelector('tbody');
			if (!tbody) return;
			const row = document.createElement('tr');
			row.innerHTML = `
				<td class="sbgx-cell sbgx-cell-check"><input type="checkbox" class="sbgx-row-cb"></td>
				<td>Run</td>
				<td>Thu, 15/05/2026</td>
				<td><a href="/activities/9000007777">Activity with edit-col</a></td>
				<td>1:00:00</td>
				<td>10.00 km</td>
				<td>50 m</td>
				<td>3</td>
				<td class="edit-col" style="display: none;">
					<form>
						<table>
							<tbody>
								<tr>
									<td class="sbgx-cell sbgx-cell-check"></td>
									<td><input type="text" name="name" value="nested form field"></td>
									<td class="sbgx-cell sbgx-cell-dl"></td>
								</tr>
							</tbody>
						</table>
					</form>
				</td>
				<td class="sbgx-cell sbgx-cell-dl"><button class="sbgx-btn sbgx-btn-primary sbgx-btn-row">GPX</button></td>
			`;
			tbody.appendChild(row);
		});

		// 100 ms observer debounce + a frame.
		await extensionPage.waitForTimeout(250);

		const outerRow = extensionPage.locator('tr[data-sbpx-id="9000007777"]');
		await expect(outerRow).toHaveCount(1);

		// The Photos button must be in the OUTER row's trailing sbgx-cell-dl,
		// sitting alongside the GPX button. The selector `:scope > td.sbgx-cell-dl`
		// only matches the direct child, which is exactly where the button
		// should be.
		const outerDl = outerRow.locator(':scope > td.sbgx-cell-dl');
		await expect(outerDl.locator('button.sbgx-btn-row')).toHaveText('GPX');
		await expect(outerDl.locator('button.sbpx-btn-row.sbpx-btn-row-coexisting')).toHaveText('Photos');

		// The Photos checkbox must be in the OUTER row's leading sbgx-cell-check,
		// not the nested one.
		const outerCheck = outerRow.locator(':scope > td.sbgx-cell-check');
		await expect(outerCheck.locator('input.sbgx-row-cb')).toHaveCount(1);
		await expect(outerCheck.locator('input.sbpx-row-cb.sbpx-row-cb-coexisting')).toHaveCount(1);

		// The nested edit-col row must NOT have any sbpx controls. If
		// reconcile crossed into it the assertions above might still pass
		// (the outer row would also get its own button), but this guard
		// catches the bug where reconcile fills BOTH rows.
		const nestedRow = extensionPage.locator('td.edit-col tbody tr');
		await expect(nestedRow.locator('input.sbpx-row-cb')).toHaveCount(0);
		await expect(nestedRow.locator('button.sbpx-btn-row')).toHaveCount(0);
		// And the nested row must not get our augmented marker, since
		// `injectAllRows` should skip it entirely.
		await expect(nestedRow).not.toHaveAttribute('data-sbpx-augmented', '1');
	});

	test('"Select all visible" ticks every row and updates the count', async ({ extensionPage }) => {
		const selectAll = extensionPage.locator('.sbpx-select-all-cb');
		await selectAll.check();
		const rowCbs = extensionPage.locator('.sbpx-row-cb');
		const count = await rowCbs.count();
		expect(count).toBe(5);
		for (let i = 0; i < count; i++) {
			await expect(rowCbs.nth(i)).toBeChecked();
		}
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('5 selected');
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeEnabled();

		await selectAll.uncheck();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('0 selected');
		await expect(extensionPage.locator('[data-role="bulk"]')).toBeDisabled();
	});

	test('toggling individual row checkboxes drives the count', async ({ extensionPage }) => {
		const cbs = extensionPage.locator('.sbpx-row-cb');
		await cbs.nth(0).check();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
		await cbs.nth(1).check();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('2 selected');
		await cbs.nth(0).uncheck();
		await expect(extensionPage.locator('[data-role="count"]')).toHaveText('1 selected');
	});

	test('bulk run with empty activity pages lands in "no photos found"', async ({ extensionPage }) => {
		await extensionPage.route('**/activities/*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html><body><p>No photos.</p></body></html>',
			});
		});

		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();

		await expect(extensionPage.locator('[data-role="status"][data-kind="warn"] [data-role="status-text"]')).toHaveText(
			'No photos found in the selected activities.',
		);
	});

	test('per-row click fetches photos (probes bare URL first, falls back to sized)', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		// One photo, 2048-sized URL exposed on the page.
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [{ id: 'photo-A', largeUrl: `${cdn}/photo-A-2048x1536.jpg`, lat: 45.5, lng: 16.0 }],
				}),
			});
		});

		// Background-SW CORS fetches go through context.route(). The
		// service worker tries the bare URL first; if it 404s, falls back
		// to the sized URL. Stub bare → 404 to exercise the fallback path,
		// and sized → success with valid JPEG bytes.
		const fetched: string[] = [];
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			const url = route.request().url();
			fetched.push(url);
			if (url === `${cdn}/photo-A.jpg`) {
				await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
				return;
			}
			// Valid minimal JPEG SOI + EOI markers, no real image content.
			// piexifjs will treat this as JPEG and try (likely fail-silent) to
			// inject EXIF; either way the downloader proceeds.
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-btn-row').first().click();

		await expect
			.poll(async () => (await readCapturedAnchorClicks(extensionPage)).length, { timeout: 5000 })
			.toBeGreaterThan(0);

		// We expect TWO fetches: bare URL probe (404) and sized URL fallback (200).
		expect(fetched).toEqual(expect.arrayContaining([`${cdn}/photo-A.jpg`, `${cdn}/photo-A-2048x1536.jpg`]));

		const clicks = await readCapturedAnchorClicks(extensionPage);
		// Single-activity downloads embed the activity id in the filename
		// (rather than the date) so the user can tell which one they got.
		const zipClick = clicks.find((c) => c.download === 'strava_media_9000000001.zip');
		expect(zipClick).toBeDefined();
	});

	test('bare URL is used directly when it serves the original', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [{ id: 'photo-B', largeUrl: `${cdn}/photo-B-2048x2048.jpg` }],
				}),
			});
		});

		const fetched: string[] = [];
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			fetched.push(route.request().url());
			// Bare URL responds 200 - the SW should stop probing and use it.
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-btn-row').first().click();
		await expect
			.poll(async () => (await readCapturedAnchorClicks(extensionPage)).length, { timeout: 5000 })
			.toBeGreaterThan(0);

		// Just one fetch - the bare URL - because it succeeded on the first try.
		expect(fetched).toHaveLength(1);
		expect(fetched[0]).toBe(`${cdn}/photo-B.jpg`);
	});

	test('bulk run aggregates photos across activities (videos excluded by default)', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		const vidCdn = 'https://d35tn3x5zm6xrc.cloudfront.net';

		// Catch-all first (LIFO routing).
		await extensionPage.route('**/activities/*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html><body></body></html>',
			});
		});
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [{ id: 'A', largeUrl: `${cdn}/A-2048x2048.jpg` }],
					videos: [{ id: 'V1', m3u8Url: `${vidCdn}/V1/hls/V1.m3u8`, thumbUrl: `${vidCdn}/V1/thumb.jpg` }],
				}),
			});
		});
		await extensionPage.route('**/activities/9000000002', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000002', { photos: [{ id: 'B', largeUrl: `${cdn}/B-2048x2048.jpg` }] }),
			});
		});

		const fetched: string[] = [];
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			fetched.push(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});
		// Defensive: catch any accidental hits to the video CDN. With the
		// include-videos checkbox OFF, this should never be exercised.
		const videoFetched: string[] = [];
		await extensionPage.context().route(`${vidCdn}/**`, async (route) => {
			videoFetched.push(route.request().url());
			await route.abort();
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();

		await expect(extensionPage.locator('[data-role="status"][data-kind="ok"] [data-role="status-text"]')).toHaveText(
			'Saved 2 photos from 2 activities.',
		);
		expect(videoFetched, 'no video CDN traffic when Include videos is off').toEqual([]);
	});

	// Sanity check: the new fixture-level catch-all `/activities/*` route
	// does NOT shadow the per-test route overrides. This matters because
	// every bulk test relies on registering tighter `/activities/<id>`
	// routes after the fixture sets up its default. If Playwright route
	// LIFO ordering ever changes, this test fails first and loudly.
	test('per-test /activities/<id> routes still override the fixture default', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', { photos: [{ id: 'OVR', largeUrl: `${cdn}/OVR-2048x2048.jpg` }] }),
			});
		});
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-btn-row').first().click();

		await expect
			.poll(async () => (await readCapturedAnchorClicks(extensionPage)).length, { timeout: 5000 })
			.toBeGreaterThan(0);
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.find((c) => c.download === 'strava_media_9000000001.zip')).toBeDefined();
	});

	test('with Include videos on, videos are fetched as HLS and lands on savedMedia', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		const vidCdn = 'https://d35tn3x5zm6xrc.cloudfront.net';

		await extensionPage.route('**/activities/*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html><body></body></html>',
			});
		});
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [{ id: 'A', largeUrl: `${cdn}/A-2048x2048.jpg` }],
					videos: [{ id: 'V1', m3u8Url: `${vidCdn}/V1/hls/V1.m3u8` }],
				}),
			});
		});

		// Stub the photo CDN.
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});

		// Stub the video CDN with a master m3u8 → media m3u8 → 2 segments
		// flow so the SW's HLS path is exercised end-to-end.
		await extensionPage.context().route(`${vidCdn}/V1/hls/V1.m3u8`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/vnd.apple.mpegurl',
				body: [
					'#EXTM3U',
					'#EXT-X-VERSION:3',
					'#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1080x1920',
					'media-hi.m3u8',
				].join('\n'),
			});
		});
		await extensionPage.context().route(`${vidCdn}/V1/hls/media-hi.m3u8`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/vnd.apple.mpegurl',
				body: [
					'#EXTM3U',
					'#EXT-X-VERSION:3',
					'#EXT-X-TARGETDURATION:6',
					'#EXTINF:5.000,',
					'seg-0.ts',
					'#EXTINF:5.000,',
					'seg-1.ts',
					'#EXT-X-ENDLIST',
				].join('\n'),
			});
		});
		const segmentFetched: string[] = [];
		await extensionPage.context().route(`${vidCdn}/V1/hls/seg-*.ts`, async (route) => {
			segmentFetched.push(route.request().url());
			// Each segment is 4 bytes of pretend MPEG-TS.
			await route.fulfill({
				status: 200,
				contentType: 'video/mp2t',
				body: Buffer.from([0x47, 0x00, 0x00, 0x00]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		// Tick the new toolbar checkbox.
		await extensionPage.locator('[data-role="include-videos"]').check();
		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();

		await expect(extensionPage.locator('[data-role="status"][data-kind="ok"] [data-role="status-text"]')).toHaveText(
			'Saved 1 photos and 1 videos from 1 activities.',
		);
		// Both video segments fetched.
		expect(segmentFetched).toHaveLength(2);

		const clicks = await readCapturedAnchorClicks(extensionPage);
		// Single-activity run → filename embeds the activity id.
		const zipClick = clicks.find((c) => c.download === 'strava_media_9000000001.zip');
		expect(zipClick).toBeDefined();
	});

	// ---------- Coverage gap: mixed-success failures ----------
	//
	// When some photos in a bulk run land and others fail (typically because
	// the CDN returns 404 for an expired URL), the downloader collects the
	// failures into `result.failed[]` and the toolbar surfaces a warn-kind
	// status reading "Saved N items, skipped M (reason)". This test pins
	// that path so future changes to the failure-reporting flow don't
	// regress it silently.
	test('partial failures land on a warn-kind "Saved N, skipped M" status', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [
						// First photo: bare URL responds 200 - succeeds.
						{ id: 'ok-1', largeUrl: `${cdn}/ok-1-2048x2048.jpg` },
						// Second photo: every URL variant 404s - fails.
						{ id: 'gone', largeUrl: `${cdn}/gone-2048x2048.jpg` },
					],
				}),
			});
		});
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			const url = route.request().url();
			if (url.includes('gone')) {
				// Both the bare URL probe and the sized URL fallback return 404,
				// so the SW exhausts every retry option and the downloader
				// records the failure with the 404 reason.
				await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-row-cb').first().check();
		await extensionPage.locator('[data-role="bulk"]').click();

		// The terminal status reads "Saved N items, skipped M (reason)" with
		// data-kind="warn". We only assert the leading prefix because the
		// exact reason text comes from the underlying fetch error and isn't
		// worth pinning verbatim.
		const status = extensionPage.locator('[data-role="status"][data-kind="warn"] [data-role="status-text"]');
		await expect(status).toContainText('Saved 1 items, skipped 1');

		// Despite the failure, the successful photo still lands in a zip.
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.find((c) => (c.download ?? '').endsWith('.zip'))).toBeDefined();
	});

	// ---------- Coverage gap: HLS error path ----------
	//
	// When Include videos is on but the master m3u8 fails to load (CDN 404,
	// network drop, etc.), the video item should be skipped while the
	// surrounding photos still save. This protects against an HLS error
	// from poisoning the entire bulk run.
	test('HLS master m3u8 failure skips the video but the photo still saves', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		const vidCdn = 'https://d35tn3x5zm6xrc.cloudfront.net';

		await extensionPage.route('**/activities/*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html><body></body></html>',
			});
		});
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [{ id: 'A', largeUrl: `${cdn}/A-2048x2048.jpg` }],
					videos: [{ id: 'V1', m3u8Url: `${vidCdn}/V1/hls/V1.m3u8` }],
				}),
			});
		});
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			await route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
		});
		// Master m3u8 returns 404 - the SW's HLS path bails out before any
		// segment fetch, propagating the error back to the downloader.
		const masterAttempts: string[] = [];
		await extensionPage.context().route(`${vidCdn}/V1/hls/V1.m3u8`, async (route) => {
			masterAttempts.push(route.request().url());
			await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('[data-role="include-videos"]').check();
		await extensionPage.locator('.sbpx-row-cb').first().check();
		await extensionPage.locator('[data-role="bulk"]').click();

		// Terminal status is warn-kind because exactly one item (the video)
		// failed. The wording mentions "skipped 1" regardless of how the
		// reason string ends up phrased.
		const status = extensionPage.locator('[data-role="status"][data-kind="warn"] [data-role="status-text"]');
		await expect(status).toContainText('skipped 1');

		// Master was attempted (we didn't silently swallow the video).
		expect(masterAttempts.length).toBeGreaterThan(0);

		// Photo still saved.
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.find((c) => (c.download ?? '').endsWith('.zip'))).toBeDefined();
	});

	// ---------- Coverage gap: EXIF metadata injection sanity ----------
	//
	// The background SW round-trips each JPEG through piexifjs to embed the
	// activity name (ImageDescription) and, when available, GPS coordinates
	// before forwarding the bytes to the content script. Asserting the
	// embedded EXIF directly would require parsing the zip blob, which we
	// don't have a clean handle on in e2e. Instead, we run a tiny canary
	// that fetches a realistic minimal JPEG (SOI + APP0/JFIF + EOI) carrying
	// GPS-tagged photo metadata. If piexifjs ever crashes on this input the
	// downloader records a failure - that's our regression signal.
	test('piexifjs injection survives a minimal JPEG with GPS metadata', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		await extensionPage.route('**/activities/9000000001', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml('9000000001', {
					photos: [
						{
							id: 'exif-A',
							largeUrl: `${cdn}/exif-A-2048x2048.jpg`,
							// GPS coordinates and a caption force the EXIF path
							// to actually write into the JPEG (rather than no-op).
							lat: 35.6895,
							lng: 139.6917,
							caption: 'Tokyo run start',
						},
					],
				}),
			});
		});
		// Minimal JPEG: SOI (FFD8) + APP0/JFIF segment + EOI (FFD9). piexifjs
		// requires at least one APP segment to know where to splice the
		// EXIF block; the bare 4-byte JPEG used by other tests skips this
		// path. The 20 bytes below are the smallest valid JFIF container.
		const minimalJpeg = Buffer.from([
			0xff,
			0xd8, // SOI
			0xff,
			0xe0,
			0x00,
			0x10, // APP0 marker + length (16)
			0x4a,
			0x46,
			0x49,
			0x46,
			0x00, // 'JFIF\0'
			0x01,
			0x01,
			0x00,
			0x00,
			0x01,
			0x00,
			0x01,
			0x00,
			0x00, // version + density
			0xff,
			0xd9, // EOI
		]);
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			await route.fulfill({ status: 200, contentType: 'image/jpeg', body: minimalJpeg });
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-row-cb').first().check();
		await extensionPage.locator('[data-role="bulk"]').click();

		// `ok`-kind status means piexifjs accepted the input. If it had
		// crashed, the downloader would have surfaced a warn or err status.
		const status = extensionPage.locator('[data-role="status"][data-kind="ok"] [data-role="status-text"]');
		await expect(status).toContainText('Saved 1 photos');
	});
});

/**
 * Single-activity page tests. These load `/activities/<id>` (the page a
 * Strava user is on when viewing one activity), and exercise the
 * single-mode toolbar that mounts under `#activity-photos-container`.
 *
 * The single-mode toolbar differs from the list-mode toolbar in three
 * behavioral ways:
 *   1. The bulk button is enabled out of the gate (no selection required).
 *   2. The button reads "Download photos" and operates on the implicit
 *      activity from the URL.
 *   3. The status line drops to its own row (full toolbar width) once a
 *      message is set, and is hidden entirely when empty.
 * Each behavior gets a dedicated assertion below.
 */
test.describe('Single-activity page', () => {
	test.use({ fixtureKind: 'activity' });

	test('mounts the single-mode toolbar inside the photos container', async ({ extensionPage }) => {
		const toolbar = extensionPage.locator('.sbpx-toolbar-single');
		await expect(toolbar).toBeVisible();
		// Lives inside Strava's photos container, not above the (non-existent) table.
		await expect(extensionPage.locator('#activity-photos-container .sbpx-toolbar-single')).toHaveCount(1);
		// No select-all or count widgets in single mode.
		await expect(extensionPage.locator('.sbpx-select-all-cb')).toHaveCount(0);
		await expect(extensionPage.locator('[data-role="count"]')).toHaveCount(0);
		// Include-videos is still present.
		await expect(extensionPage.locator('[data-role="include-videos"]')).toBeVisible();
	});

	test('bulk button starts enabled (activity is implicit, no selection needed)', async ({ extensionPage }) => {
		// In list mode the bulk button starts disabled (no rows checked).
		// In single mode the activity from the URL is the implicit target,
		// so the button is immediately actionable.
		const bulk = extensionPage.locator('[data-role="bulk"]');
		await expect(bulk).toBeVisible();
		await expect(bulk).toBeEnabled();
		await expect(bulk).toHaveText('Download photos');
	});

	test('status line lands on its own row beneath the controls, full toolbar width', async ({ extensionPage }) => {
		// Seed a status message - we don't want to wait for a real download
		// to land in a particular kind, we just need any non-empty text.
		await extensionPage.evaluate(() => {
			const span = document.querySelector<HTMLElement>('.sbpx-toolbar-single [data-role="status-text"]');
			if (span) span.textContent = 'Saved 3 photos to your downloads folder.';
		});

		const measurements = await extensionPage.evaluate(() => {
			const t = document.querySelector<HTMLElement>('.sbpx-toolbar-single')!;
			const btn = t.querySelector<HTMLElement>('.sbpx-btn-primary')!.getBoundingClientRect();
			const status = t.querySelector<HTMLElement>('.sbpx-status')!.getBoundingClientRect();
			return {
				statusBelowButton: status.top >= btn.bottom,
				statusFullWidth: status.width > t.getBoundingClientRect().width - 80,
			};
		});
		expect(measurements.statusBelowButton, 'status drops to row 2').toBe(true);
		expect(measurements.statusFullWidth, 'status takes the full toolbar width').toBe(true);
	});

	test('empty status collapses (no blank strip under the controls)', async ({ extensionPage }) => {
		// Toolbar just mounted, status hasn't been set - the row should be
		// `display: none` so the toolbar reads as a single row.
		const visible = await extensionPage.evaluate(() => {
			const status = document.querySelector<HTMLElement>('.sbpx-toolbar-single .sbpx-status')!;
			return getComputedStyle(status).display !== 'none';
		});
		expect(visible).toBe(false);
	});

	test('Ko-fi badge is omitted on single-activity toolbar', async ({ extensionPage }) => {
		// The "Buy me a coffee" pill makes sense on the activities-list page
		// where the toolbar stretches across the full table width; on the
		// single-activity page the toolbar lives inside a narrow photos
		// container and the badge would crowd the action button. Locking this
		// behavior down so a future refactor doesn't accidentally bring it
		// back across both modes.
		await expect(extensionPage.locator('.sbpx-toolbar-single .sbpx-kofi')).toHaveCount(0);
	});

	test('one-click download fetches photos and writes strava_media_<id>.zip', async ({ extensionPage }) => {
		const cdn = 'https://dgtzuqphqg23d.cloudfront.net';
		// Override the fixture default so this specific activity returns
		// a page with one photo's worth of react-props.
		await extensionPage.route(`**/activities/${SINGLE_FIXTURE_ACTIVITY_ID}`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: activityPageHtml(SINGLE_FIXTURE_ACTIVITY_ID, {
					photos: [{ id: 'single-A', largeUrl: `${cdn}/single-A-2048x2048.jpg` }],
				}),
			});
		});
		await extensionPage.context().route(`${cdn}/**`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'image/jpeg',
				body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
			});
		});

		await installAnchorClickCapture(extensionPage);
		await extensionPage.locator('.sbpx-toolbar-single [data-role="bulk"]').click();

		await expect
			.poll(async () => (await readCapturedAnchorClicks(extensionPage)).length, { timeout: 5000 })
			.toBeGreaterThan(0);
		const clicks = await readCapturedAnchorClicks(extensionPage);
		expect(clicks.find((c) => c.download === `strava_media_${SINGLE_FIXTURE_ACTIVITY_ID}.zip`)).toBeDefined();
	});

	test('dark-mode CSS variables flip when html.dark is set', async ({ extensionPage }) => {
		// Light-mode baseline.
		const light = await extensionPage.evaluate(() => {
			const t = document.querySelector<HTMLElement>('.sbpx-toolbar-single')!;
			return getComputedStyle(t).backgroundColor;
		});
		// Flip to dark via the explicit class Strava uses on its own toggle.
		const dark = await extensionPage.evaluate(() => {
			document.documentElement.classList.add('dark');
			const t = document.querySelector<HTMLElement>('.sbpx-toolbar-single')!;
			return getComputedStyle(t).backgroundColor;
		});
		// Light is white-ish (rgb(255,255,255)), dark is our charcoal (rgb(28,31,38)).
		expect(light).toBe('rgb(255, 255, 255)');
		expect(dark).toBe('rgb(28, 31, 38)');
	});
});
