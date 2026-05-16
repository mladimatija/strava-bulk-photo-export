// Generates two sets of screenshots from the same fixtures the e2e tests use:
//
//   1. README screenshots (tight bounding-box crops of the toolbar / row /
//      terminal state) → docs/screenshots/.
//   2. Chrome Web Store listing screenshots (full-viewport 1280×800 PNGs) →
//      docs/store/.
//
// Run with `npm run test:screenshots`. The `pretest:screenshots` script
// runs `npm run build` first, so the fixture loads the latest extension code.
//
// The mid-flight (bulk.png) and terminal-success shots stub the photo CDN
// the same way the e2e specs do, so we get realistic spinner / "Saved N
// photos…" states without needing real Strava credentials.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, SINGLE_FIXTURE_ACTIVITY_ID, type Page } from '../fixtures/extension.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readmeDir = path.resolve(__dirname, '../../docs/screenshots');
const storeDir = path.resolve(__dirname, '../../docs/store');

// Chrome Web Store accepts either 1280×800 or 640×400 PNG/JPEG. 1280×800
// reads well at the listing's "Screenshots" carousel size.
const STORE_VIEWPORT = { width: 1280, height: 800 } as const;

const PHOTO_CDN = 'https://dgtzuqphqg23d.cloudfront.net';

/**
 * Build a Strava-style `/activities/<id>` HTML response with N photos in the
 * `data-react-props` blob the production discovery code parses. Mirrors the
 * helper in the e2e spec but kept local so screenshot tests don't depend on
 * the spec file. Each generated photo points at a unique URL on the photo
 * CDN so the stubbed routes can match every entry.
 */
function activityPageHtml(activityId: string, photoCount: number): string {
	const photos = Array.from({ length: photoCount }, (_, i) => ({
		photo_id: `${activityId}-${i}`,
		id: `${activityId}-${i}`,
		media_type: 1,
		activity_id: activityId,
		thumbnail: `${PHOTO_CDN}/${activityId}-${i}-2048x1536.jpg`,
		large: `${PHOTO_CDN}/${activityId}-${i}-2048x1536.jpg`,
		video: null,
		lat: null,
		lng: null,
		caption_escaped: '',
		dimensions: { large: { width: 2048, height: 1536 }, thumbnail: { width: 2048, height: 1536 } },
	}));
	const propsAttr = JSON.stringify({ photos, viewableCount: photos.length, category: 'activity_detail' }).replace(
		/"/g,
		'&quot;',
	);
	return `<!doctype html><html><head><title>Photos | Strava</title></head><body>
<div data-react-class="PhotoGallery" data-react-props="${propsAttr}"></div>
</body></html>`;
}

/**
 * Stub the photo CDN with a tiny valid JPEG, and (optionally) stub each
 * `/activities/<id>` response with `photosPerActivity` synthetic photos.
 * Used by mid-flight + terminal screenshot specs so the discovery + zip
 * pipeline runs end-to-end against the in-process Playwright network mock.
 *
 * `photoDelayMs` slows the photo CDN response so the mid-flight spinner is
 * visible long enough to screenshot. Without a delay, the stubbed network
 * resolves in <1ms and the toolbar jumps straight to the terminal state.
 */
async function stubPhotoNetwork(
	page: Page,
	opts: { photosPerActivity?: number; photoDelayMs?: number } = {},
): Promise<void> {
	const { photosPerActivity = 4, photoDelayMs = 0 } = opts;
	await page.context().route(`${PHOTO_CDN}/**`, async (route) => {
		if (photoDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, photoDelayMs));
		}
		await route.fulfill({
			status: 200,
			contentType: 'image/jpeg',
			body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
		});
	});
	// Override the fixture default `/activities/*` route with photo-bearing
	// HTML. We register narrowly so the new route takes precedence over the
	// fixture default (Playwright applies the latest-registered match first).
	await page.route('https://www.strava.com/activities/*', async (route) => {
		const url = route.request().url();
		const m = /\/activities\/(\d+)/.exec(url);
		const id = m?.[1] ?? '9000000000';
		await route.fulfill({
			status: 200,
			contentType: 'text/html; charset=utf-8',
			body: activityPageHtml(id, photosPerActivity),
		});
	});
}

/**
 * Suppress the anchor download that the toolbar triggers when the zip is
 * ready. Without this the browser tries to actually save the file and the
 * screenshot test ends up writing test-results spam.
 */
async function suppressZipDownload(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.addEventListener(
			'click',
			(e) => {
				if (e.target instanceof HTMLAnchorElement) {
					e.preventDefault();
					e.stopImmediatePropagation();
				}
			},
			true,
		);
	});
}

test.describe('README screenshots', () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test('toolbar - idle, 0 selected', async ({ extensionPage }) => {
		const toolbar = extensionPage.locator('.sbpx-toolbar');
		await toolbar.screenshot({ path: path.join(readmeDir, 'toolbar.png') });
	});

	test('per-row - checkbox + Photos button on a row', async ({ extensionPage }) => {
		const row = extensionPage.locator('tr[data-sbpx-id]').first();
		await row.scrollIntoViewIfNeeded();
		await row.screenshot({ path: path.join(readmeDir, 'per-row.png') });
	});

	test('bulk - mid-download with spinner visible', async ({ extensionPage }) => {
		// Slow each photo fetch so the in-flight "Downloading N / M…" state
		// stays on screen long enough to capture. Without the delay the
		// stubbed network resolves in <1ms and the toolbar lands on the
		// terminal "Saved N photos" status before the screenshot fires.
		await stubPhotoNetwork(extensionPage, { photosPerActivity: 4, photoDelayMs: 250 });
		await suppressZipDownload(extensionPage);

		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		// Wait for the info-kind status to render (the in-flight state with
		// the spinner alongside "Downloading N / M…" or "Preparing…").
		await extensionPage.locator('[data-role="status"][data-kind="info"]').waitFor({ state: 'visible', timeout: 5000 });
		// One animation frame so the spinner's rotate transform has a
		// definite angle in the screenshot.
		await extensionPage.waitForTimeout(80);
		await extensionPage.locator('.sbpx-toolbar').screenshot({
			path: path.join(readmeDir, 'bulk.png'),
		});
	});
});

test.describe('README screenshots - single-activity page', () => {
	test.use({
		viewport: { width: 1400, height: 900 },
		fixtureKind: 'activity',
	});

	test('single-toolbar - idle, status hidden', async ({ extensionPage }) => {
		// Container has the photo strip + toolbar; this is the shape a user
		// sees the first time they land on an activity with photos.
		const container = extensionPage.locator('#activity-photos-container');
		await container.scrollIntoViewIfNeeded();
		await container.screenshot({ path: path.join(readmeDir, 'single-toolbar.png') });
	});

	test('single-toolbar - terminal "Saved 4 photos" state with status on new row', async ({ extensionPage }) => {
		await stubPhotoNetwork(extensionPage, { photosPerActivity: 4 });
		await suppressZipDownload(extensionPage);

		await extensionPage.locator('.sbpx-toolbar-single [data-role="bulk"]').click();
		// Wait for the terminal `ok` status to land - that's the moment the
		// status row is visible and "Saved N photos…" reads cleanly.
		await extensionPage.locator('.sbpx-toolbar-single [data-role="status"][data-kind="ok"]').waitFor({ timeout: 5000 });
		const container = extensionPage.locator('#activity-photos-container');
		await container.scrollIntoViewIfNeeded();
		await container.screenshot({ path: path.join(readmeDir, 'single-toolbar-saved.png') });
	});
});

// Full-page 1280×800 shots that map to the suggested shot list in
// docs/CHROME_WEB_STORE.md. The Strava fixtures are generic enough that
// these read like real Strava pages minus the chrome around them.
test.describe('Chrome Web Store listing screenshots', () => {
	test.use({ viewport: STORE_VIEWPORT });

	test('1-toolbar-idle - nothing selected', async ({ extensionPage }) => {
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-1-toolbar.png'),
			fullPage: false,
		});
	});

	test('2-row-button - close-up of a row with the Photos button', async ({ extensionPage }) => {
		await extensionPage
			.locator('tr[data-sbpx-id]')
			.first()
			.screenshot({
				path: path.join(storeDir, 'screenshot-2-row-button.png'),
			});
	});

	test('3-bulk-progress - mid-flight bulk download with spinner', async ({ extensionPage }) => {
		await stubPhotoNetwork(extensionPage, { photosPerActivity: 4, photoDelayMs: 250 });
		await suppressZipDownload(extensionPage);

		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		await extensionPage.locator('[data-role="status"][data-kind="info"]').waitFor({ state: 'visible', timeout: 5000 });
		await extensionPage.waitForTimeout(80);
		await extensionPage.screenshot({ path: path.join(storeDir, 'screenshot-3-bulk-progress.png') });
	});

	test('4-bulk-success - terminal "Saved N photos" state on the list page', async ({ extensionPage }) => {
		await stubPhotoNetwork(extensionPage, { photosPerActivity: 4 });
		await suppressZipDownload(extensionPage);

		await extensionPage.locator('.sbpx-select-all-cb').check();
		await extensionPage.locator('[data-role="bulk"]').click();
		await extensionPage.locator('[data-role="status"][data-kind="ok"]').waitFor({ timeout: 8000 });
		await extensionPage.screenshot({ path: path.join(storeDir, 'screenshot-4-bulk-success.png') });
	});
});

test.describe('Chrome Web Store listing screenshots - single-activity page', () => {
	test.use({
		viewport: STORE_VIEWPORT,
		fixtureKind: 'activity',
	});

	test('5-single-toolbar - idle, photo strip + toolbar below', async ({ extensionPage }) => {
		// Full-page shot: heading, photo strip, toolbar, sidebar.
		await extensionPage.screenshot({
			path: path.join(storeDir, 'screenshot-5-single-toolbar.png'),
			fullPage: false,
		});
	});

	test('6-single-success - one-click "Saved N photos" terminal state', async ({ extensionPage }) => {
		// Use the fixture's own activity id so the discovery path resolves.
		await stubPhotoNetwork(extensionPage, { photosPerActivity: 4 });
		await suppressZipDownload(extensionPage);

		await extensionPage.locator('.sbpx-toolbar-single [data-role="bulk"]').click();
		await extensionPage.locator('.sbpx-toolbar-single [data-role="status"][data-kind="ok"]').waitFor({ timeout: 8000 });
		// Anchor the shot on the photos container so the status line on its
		// new row is the visual focus rather than the sidebar.
		await extensionPage.screenshot({ path: path.join(storeDir, 'screenshot-6-single-success.png') });
		// Reference SINGLE_FIXTURE_ACTIVITY_ID so a typo there fails this test.
		void SINGLE_FIXTURE_ACTIVITY_ID;
	});
});
