// Media discovery + bulk download for Strava activity photos and (optionally)
// videos.
//
// Discovery: fetch `/activities/<id>` and parse Strava's embedded React
// props blob to get a structured list of media items - URLs, GPS coords,
// captions, photo/video distinction, etc. Falls back to a regex sweep
// across the raw HTML if the structured parse misses (covers A/B test
// buckets, partial JSON blobs).
//
// Downloading: all cross-origin fetches happen in the extension's service
// worker (see src/background.ts). MV3 content scripts inherit the host
// page's CORS context even with host_permissions, so the page-context
// code here only handles discovery and progress orchestration. The SW
// also injects EXIF metadata into JPEGs and concatenates HLS .ts segments
// into a single video file before sending bytes back.

import JSZip from 'jszip';
import { renderFilenameTemplate, type FilenameTemplateContext } from './filename-template.ts';
import { loadFilenameTemplate, loadSavedMediaIds, markMediaIdsSaved } from './storage.ts';
import type { ActivityRow, BulkResult, DownloadOptions, MediaRef } from './types.ts';

// ---------- Debug logging seam ----------

/**
 * Toggle from DevTools while troubleshooting:
 *   1. `window.__sbpx_debug = true`
 *   2. Click a row's "Photos" button.
 *   3. `[sbpx]` lines appear in the console; the last activity HTML is
 *      stashed on `window.__sbpx_last_response` for grepping.
 *
 * Flag is checked at call time so you can toggle without reloading.
 */
interface SbpxDebugGlobals {
	__sbpx_debug?: boolean;
	__sbpx_last_response?: string;
	__sbpx_last_media?: MediaRef[];
}
function dbg(...args: unknown[]): void {
	if ((globalThis as unknown as SbpxDebugGlobals).__sbpx_debug) {
		console.debug('[sbpx]', ...args);
	}
}
function stashLastResponse(html: string): void {
	if ((globalThis as unknown as SbpxDebugGlobals).__sbpx_debug) {
		(globalThis as unknown as SbpxDebugGlobals).__sbpx_last_response = html;
	}
}
function stashLastMedia(media: MediaRef[]): void {
	if ((globalThis as unknown as SbpxDebugGlobals).__sbpx_debug) {
		(globalThis as unknown as SbpxDebugGlobals).__sbpx_last_media = media;
	}
}

// ---------- URL classification ----------

/**
 * CloudFront host that serves Strava activity photos.
 *
 *   - `dgtzuqphqg23d.cloudfront.net` - activity photos.
 *   - `d35tn3x5zm6xrc.cloudfront.net` - video thumbnails + HLS streams
 *     (used by the video flow; not a "photo" host per se, but we'll
 *     accept thumbnails on this CDN).
 *   - `d3nn82uaxijpm6.cloudfront.net` - static assets (CSS, JS, icons).
 *     EXPLICITLY excluded.
 *   - `dgalywyr863hv.cloudfront.net` - athlete profile pictures.
 *     EXPLICITLY excluded.
 *
 * Manifest `host_permissions` must include any host we plan to fetch from.
 */
const PHOTO_HOSTS = ['dgtzuqphqg23d.cloudfront.net'] as const;
const VIDEO_HOSTS = ['d35tn3x5zm6xrc.cloudfront.net'] as const;

/** Trailing size suffix like `-768x768.jpg` or `-2048x2048` (no extension). */
const SIZE_SUFFIX_RE = /-(\d+)x(\d+)(\.[a-z0-9]+)?$/i;

function isPhotoCdnUrl(url: string): boolean {
	try {
		return (PHOTO_HOSTS as readonly string[]).includes(new URL(url).host);
	} catch {
		return false;
	}
}
function isVideoCdnUrl(url: string): boolean {
	try {
		return (VIDEO_HOSTS as readonly string[]).includes(new URL(url).host);
	} catch {
		return false;
	}
}

/** Guess a file extension from a URL's pathname. Defaults to `jpg`. */
function extensionFromUrl(url: string, fallback = 'jpg'): string {
	try {
		const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
		return (m?.[1] ?? fallback).toLowerCase();
	} catch {
		return fallback;
	}
}

/** Normalize an empty string to `undefined`. Used for trimmed Strava captions. */
function emptyToUndefined(s: string | undefined): string | undefined {
	return s === undefined || s === '' ? undefined : s;
}

/**
 * Strip the `-WxH` size suffix from a photo URL. Strava's photo CDN often
 * (but not always) serves the original-resolution upload at the bare URL.
 * If the bare URL 404s the service worker falls back to the sized URL
 * automatically.
 */
function stripSizeSuffix(url: string): string {
	try {
		const u = new URL(url);
		const stripped = u.pathname.replace(SIZE_SUFFIX_RE, '$3');
		return `${u.origin}${stripped}${u.search}${u.hash}`;
	} catch {
		return url;
	}
}

/**
 * Build the candidate URL list the service worker should try in order.
 * `bare URL` first (the best chance at original-resolution upload); page-URL
 * fallback last, so we always get *something* even if Strava never serves
 * a bare URL on this account.
 */
function urlCandidates(pageUrl: string): string[] {
	const bare = stripSizeSuffix(pageUrl);
	return bare !== pageUrl ? [bare, pageUrl] : [pageUrl];
}

// ---------- Discovery: parse Strava's embedded JSON ----------

/**
 * Strava embeds activity-level photo data as a JSON array inside an HTML
 * attribute on the activity page (the React props for the photo gallery
 * component). This is the canonical shape we look for:
 *
 *   [{
 *      photo_id: "9F069920-…",
 *      id:        11370227372,
 *      media_type: 1,                            // 1 = photo, 2 = video
 *      activity_id: 18437723885,
 *      thumbnail: "https://…cloudfront.net/<hash>-2048x1152.jpg",
 *      large:     "https://…cloudfront.net/<hash>-2048x1152.jpg",
 *      video:     null,                          // .m3u8 URL for videos
 *      lat:       45.95981…,
 *      lng:       16.24295…,
 *      caption_escaped: "",
 *      dimensions: { large: { width, height }, thumbnail: {…} },
 *      …
 *   }, …]
 *
 * The fields we actually need are `media_type`, `large` (or `thumbnail`
 * as a fallback), `video`, `lat`, `lng`, `caption_escaped`, `id`.
 */
interface StravaMediaJson {
	photo_id?: string;
	id?: string | number;
	media_type?: number;
	activity_id?: string | number;
	thumbnail?: string;
	large?: string;
	video?: string | null;
	lat?: number | null;
	lng?: number | null;
	caption_escaped?: string;
	/**
	 * Photo creation time as ISO 8601. Strava's web payload exposes this
	 * under either `created_at` (UTC) or `created_at_local` (local TZ);
	 * we accept both. Used as the per-photo EXIF DateTimeOriginal when
	 * present; otherwise we fall back to the activity-level start time.
	 */
	created_at?: string;
	created_at_local?: string;
	dimensions?: { large?: { width?: number; height?: number } };
}

/**
 * Decode the entities Strava emits inside attribute-embedded JSON.
 * `&amp;` MUST be last (re-decoding cascade hazard).
 */
function decodeHtmlEntities(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;/g, "'")
		.replace(/&#34;/g, '"')
		.replace(/&amp;/g, '&');
}

/** Recursively walk a parsed JSON object looking for the photo array. */
function findPhotosArray(obj: unknown): StravaMediaJson[] {
	if (Array.isArray(obj)) {
		// Heuristic: an array of objects where every (or at least one)
		// element has `media_type` is the photo array. We use "at least
		// one" so a partial/inconsistent payload still works.
		if (obj.some((item) => typeof item === 'object' && item !== null && 'media_type' in item)) {
			return obj.filter((item): item is StravaMediaJson => typeof item === 'object' && item !== null);
		}
	}
	if (typeof obj === 'object' && obj !== null) {
		for (const value of Object.values(obj as Record<string, unknown>)) {
			const found = findPhotosArray(value);
			if (found.length > 0) return found;
		}
	}
	return [];
}

/**
 * DOM-based primary path: walk every element with a `data-*` attribute
 * whose value looks like JSON containing a `media_type` marker and try
 * to parse it. The first parse that yields a non-empty photos array wins.
 */
function discoverMediaViaDom(html: string): StravaMediaJson[] {
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		for (const el of doc.querySelectorAll('[data-react-props], [data-props], [data-photos], [data-photo-gallery]')) {
			for (const attr of Array.from(el.attributes)) {
				if (!attr.name.startsWith('data-')) continue;
				const value = attr.value;
				if (!value.includes('media_type')) continue;
				try {
					// DOMParser already entity-decoded the attribute, so
					// this should be valid JSON as-is.
					const parsed: unknown = JSON.parse(value);
					const photos = findPhotosArray(parsed);
					if (photos.length > 0) {
						dbg('  discovery: DOM path matched on', el.tagName, attr.name, '- items:', photos.length);
						return photos;
					}
				} catch {
					/* not JSON / wrong shape */
				}
			}
		}
	} catch {
		/* DOMParser unavailable or parse error */
	}
	return [];
}

/**
 * Regex fallback: scan the entity-decoded HTML for inline JSON objects
 * whose top level mentions `media_type`. Less reliable than the DOM
 * walk but catches cases where Strava embeds the JSON outside the
 * standard `data-*` attributes (script tag, comment, etc.).
 */
function discoverMediaViaRegex(html: string): StravaMediaJson[] {
	const decoded = decodeHtmlEntities(html);
	// Find every brace-balanced JSON object that mentions media_type.
	// We can't fully tokenize without writing a parser, so we use a
	// dumb cursor approach: when we see "media_type", walk backwards to
	// the nearest `{` and forwards to the matching `}`, then try to parse.
	const out: StravaMediaJson[] = [];
	const seen = new Set<string>();
	let cursor = 0;
	while (cursor < decoded.length) {
		const hit = decoded.indexOf('"media_type"', cursor);
		if (hit < 0) break;
		cursor = hit + 1;
		// Walk back to enclosing '['
		const openBracket = decoded.lastIndexOf('[', hit);
		if (openBracket < 0) continue;
		// Find matching close bracket from there.
		const closeBracket = findMatching(decoded, openBracket, '[', ']');
		if (closeBracket < 0) continue;
		const slice = decoded.slice(openBracket, closeBracket + 1);
		if (seen.has(slice)) {
			cursor = closeBracket + 1;
			continue;
		}
		seen.add(slice);
		try {
			const parsed: unknown = JSON.parse(slice);
			const photos = findPhotosArray(parsed);
			if (photos.length > 0) {
				dbg('  discovery: regex path matched array - items:', photos.length);
				return photos;
			}
		} catch {
			/* malformed - try next */
		}
		cursor = closeBracket + 1;
		// Defensive cap: don't loop forever scanning a huge page.
		if (out.length > 50) break;
	}
	return out;
}

/**
 * Pull the activity's start time out of the page. Tried in order:
 *
 *   1. `start_date_local` / `start_date` / `start_time` inside the
 *      React-props JSON (matches Strava's web payload shape, where the
 *      activity-detail blob carries `start_date_local: "2024-05-14T10:30:00"`).
 *      `_local` is preferred because EXIF DateTimeOriginal is a local-time
 *      field (no TZ).
 *   2. The `datetime="…"` attribute on any `<time>` element inside the
 *      activity heading - Strava renders one near the activity title with
 *      the time in machine-readable ISO form.
 *
 * Falls through to undefined if neither shows up. We do not try to parse
 * the human-readable inner text of `<time>` (e.g. "09:16 on Wednesday, 6
 * May 2026") because the format varies per Chrome locale and is brittle
 * to localize across.
 */
export function extractActivityStartTime(html: string): string | undefined {
	const decoded = decodeHtmlEntities(html);
	const jsonMatch =
		/"start_date_local"\s*:\s*"([^"]+)"/.exec(decoded) ??
		/"start_date"\s*:\s*"([^"]+)"/.exec(decoded) ??
		/"start_time"\s*:\s*"([^"]+)"/.exec(decoded);
	if (jsonMatch?.[1]) return jsonMatch[1];
	const attrMatch = /<time[^>]*\bdatetime\s*=\s*"([^"]+)"/i.exec(html);
	return attrMatch?.[1] ?? undefined;
}

/** Find the index of the matching close character, respecting strings + nesting. */
function findMatching(s: string, open: number, openCh: string, closeCh: string): number {
	let depth = 0;
	let inStr = false;
	let escape = false;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (c === '\\') {
			escape = true;
			continue;
		}
		if (c === '"') {
			inStr = !inStr;
			continue;
		}
		if (inStr) continue;
		if (c === openCh) depth++;
		else if (c === closeCh) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Translate a raw Strava JSON entry into the typed MediaRef the
 * downloader uses. Photos and videos take the same shape - the
 * `mediaType` discriminator tells the SW which fetch path to take.
 *
 * Photo and video indices are tracked separately, so filenames inside
 * the zip read as `photo-01.jpg, photo-02.jpg, …` and
 * `video-01.ts, video-02.ts, …` rather than interleaved
 * (`photo-01, photo-03, video-04, photo-05, …`).
 */
function toMediaRef(
	raw: StravaMediaJson,
	activity: ActivityRow,
	indices: { photo: number; video: number },
	activityStartTime: string | undefined,
): MediaRef | null {
	const mediaType = raw.media_type === 2 ? 'video' : 'photo';
	// Per-photo created_at_local wins over activity-level start time.
	// `_local` is preferred because EXIF DateTimeOriginal has no TZ field
	// and reads any timestamp as local time - matching local-clock
	// semantics avoids photos showing as "off by 9 hours" in Apple Photos
	// for activities recorded abroad.
	const dateTimeOriginal = raw.created_at_local ?? raw.created_at ?? activityStartTime;

	if (mediaType === 'video') {
		const m3u8 = typeof raw.video === 'string' ? raw.video : '';
		if (!m3u8 || !isVideoCdnUrl(m3u8)) return null;
		const kindIndex = indices.video + 1;
		const ext = 'ts';
		return {
			activityId: activity.id,
			mediaId: String(raw.photo_id ?? raw.id ?? `v-${indices.video}`),
			mediaType,
			url: m3u8,
			thumbnailUrl: typeof raw.thumbnail === 'string' && isVideoCdnUrl(raw.thumbnail) ? raw.thumbnail : undefined,
			lat: typeof raw.lat === 'number' ? raw.lat : undefined,
			lng: typeof raw.lng === 'number' ? raw.lng : undefined,
			caption: emptyToUndefined(raw.caption_escaped?.trim()),
			dateTimeOriginal,
			kindIndex,
			ext,
			suggestedFilename: `${activity.id}/video-${String(kindIndex).padStart(2, '0')}.${ext}`,
		};
	}

	// Photo path. Prefer `large` over `thumbnail` (identical on smaller
	// uploads; bigger on larger originals).
	const url = (typeof raw.large === 'string' ? raw.large : raw.thumbnail) ?? '';
	if (!url || !isPhotoCdnUrl(url)) return null;
	const kindIndex = indices.photo + 1;
	const ext = extensionFromUrl(url, 'jpg');
	return {
		activityId: activity.id,
		mediaId: String(raw.photo_id ?? raw.id ?? `p-${indices.photo}`),
		mediaType,
		url,
		thumbnailUrl: typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined,
		lat: typeof raw.lat === 'number' ? raw.lat : undefined,
		lng: typeof raw.lng === 'number' ? raw.lng : undefined,
		caption: emptyToUndefined(raw.caption_escaped?.trim()),
		dateTimeOriginal,
		kindIndex,
		ext,
		suggestedFilename: `${activity.id}/photo-${String(kindIndex).padStart(2, '0')}.${ext}`,
	};
}

/**
 * Discover every media item attached to a given activity.
 *
 * Returns photos and videos in the order they appear in Strava's JSON.
 * Callers that only want photos should filter on `mediaType === 'photo'`.
 *
 * HTTP / network errors throw; the caller treats per-activity discovery
 * failures as recoverable.
 */
export async function discoverMediaForActivity(activity: ActivityRow, signal?: AbortSignal): Promise<MediaRef[]> {
	const url = `/activities/${activity.id}`;
	dbg('fetch', url);
	const res = await fetch(url, {
		method: 'GET',
		credentials: 'same-origin',
		redirect: 'follow',
		signal,
	});
	dbg('  status', res.status, 'final url', res.url);
	const html = await res.text();
	dbg('  response bytes', html.length);
	stashLastResponse(html);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);

	let raw = discoverMediaViaDom(html);
	if (raw.length === 0) raw = discoverMediaViaRegex(html);

	// Activity-level start time is used as a fallback for photos that
	// don't carry their own `created_at`. We resolve it once per page,
	// not once per photo, since the source HTML is identical.
	const activityStartTime = extractActivityStartTime(html);

	// Dedupe by photo_id/id so a JSON payload that includes a photo twice
	// (lightbox + carousel buckets) doesn't double-fetch.
	const seen = new Set<string>();
	const refs: MediaRef[] = [];
	const indices = { photo: 0, video: 0 };
	for (const item of raw) {
		const ref = toMediaRef(item, activity, indices, activityStartTime);
		if (!ref) continue;
		if (seen.has(ref.mediaId)) continue;
		seen.add(ref.mediaId);
		refs.push(ref);
		if (ref.mediaType === 'video') indices.video++;
		else indices.photo++;
	}
	dbg('  discovered', refs.length, 'media items');
	stashLastMedia(refs);
	return refs;
}

/**
 * Back-compat alias used by older code paths and tests. Returns ONLY
 * photos; videos are filtered out.
 */
export async function discoverPhotosForActivity(activity: ActivityRow): Promise<MediaRef[]> {
	const all = await discoverMediaForActivity(activity);
	return all.filter((m) => m.mediaType === 'photo');
}

// ---------- Service-worker proxy helpers ----------

// Two-shape success envelope. `chrome.runtime.sendMessage` JSON-serializes
// in MV3 (so typed arrays don't survive) AND caps a single message at
// 64 MiB. The SW therefore inlines small payloads as base64 and hands
// back a `transferId` for anything larger; we drain the bytes in chunks.
interface FetchInlineSuccess {
	ok: true;
	kind: 'photo' | 'video';
	inline: true;
	base64: string;
	mimeType: string;
}
interface FetchChunkedSuccess {
	ok: true;
	kind: 'photo' | 'video';
	inline: false;
	transferId: string;
	totalBytes: number;
	mimeType: string;
}
interface ReadChunkSuccess {
	ok: true;
	base64: string;
	done: boolean;
	/** Absolute byte offset the NEXT `sbpx-read-chunk` request should ask for. */
	nextOffset: number;
}
type FetchSuccess = FetchInlineSuccess | FetchChunkedSuccess;
type FetchResponse = FetchSuccess | { ok: false; error: string };
type ReadChunkResponse = ReadChunkSuccess | { ok: false; error: string };

/**
 * Decode a base64 string to a Uint8Array, the inverse of bytesToBase64 in
 * the SW. Pinned to `Uint8Array<ArrayBuffer>` so the result satisfies
 * `Blob`'s `BufferSource` constraint under TS 6's stricter generics
 * (which exclude `SharedArrayBuffer`-backed views from BlobPart).
 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binStr = atob(base64);
	const bytes = new Uint8Array(binStr.length);
	for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
	return bytes;
}

/**
 * Materialize a SW response into a Blob.
 *
 * Inline path: a single base64 decode → Blob. Chunked path: drain the SW
 * in slices, pipelining the next chunk's request before decoding the
 * current one so we never block the SW round-trip on the CPU work of a
 * base64 decode. For a 100 MiB video (~4 chunks at 24 MiB each) that
 * roughly halves the effective transport overhead.
 *
 * On completion (or on a mid-drain throw), the explicit
 * `sbpx-release-transfer` lets the SW reclaim its held bytes immediately
 * instead of waiting out the 5-minute TTL.
 */
async function materializeBlob(res: FetchSuccess): Promise<Blob> {
	if (res.inline) {
		return new Blob([base64ToBytes(res.base64)], { type: res.mimeType });
	}
	const parts: Uint8Array<ArrayBuffer>[] = [];
	// Prime the pipeline with the first request, then on each iteration
	// dispatch the next request BEFORE decoding the current chunk's bytes.
	let pending: Promise<ReadChunkResponse | undefined> = chrome.runtime.sendMessage({
		type: 'sbpx-read-chunk',
		transferId: res.transferId,
		offset: 0,
	});
	while (true) {
		const chunk = await pending;
		if (!chunk) throw new Error('Extension service worker unavailable - try reloading the page.');
		if (!chunk.ok) throw new Error(chunk.error);
		// Schedule the next request before paying for the base64 decode. The
		// SW already knows whether `done` is true (it'll respond with an
		// error if we ask past the end), and the unused promise is released
		// silently if `done` lands first; the SW also self-releases on the
		// final `done: true` so the speculative read isn't a memory issue.
		if (!chunk.done) {
			pending = chrome.runtime.sendMessage({
				type: 'sbpx-read-chunk',
				transferId: res.transferId,
				offset: chunk.nextOffset,
			});
		}
		parts.push(base64ToBytes(chunk.base64));
		if (chunk.done) break;
	}
	// The SW also self-releases when `done: true`, but on any abnormal
	// path (caller threw mid-loop, etc.) the explicit release keeps SW
	// memory clean. Fire-and-forget; failures here don't matter to the user.
	void chrome.runtime.sendMessage({ type: 'sbpx-release-transfer', transferId: res.transferId });
	return new Blob(parts, { type: res.mimeType });
}

/**
 * Fetch a photo (with URL fallback + EXIF injection) through the SW.
 * Throws on failure; returns the bytes as a Blob.
 */
async function fetchPhotoViaWorker(
	url: string,
	metadata: { lat?: number; lng?: number; caption?: string; activityName?: string; dateTimeOriginal?: string },
): Promise<Blob> {
	// Annotate at the declaration so typescript-eslint's no-unsafe-assignment
	// is happy - bare `await chrome.runtime.sendMessage(…)` returns `any`,
	// and the linter strips trailing `as T | undefined` casts on auto-fix.
	const res: FetchResponse | undefined = await chrome.runtime.sendMessage({
		type: 'sbpx-fetch-photo',
		urlCandidates: urlCandidates(url),
		metadata,
	});
	if (!res) throw new Error('Extension service worker unavailable - try reloading the page.');
	if (!res.ok) throw new Error(res.error);
	return await materializeBlob(res);
}

/**
 * Fetch an HLS video (master .m3u8 → media playlist → segments →
 * concatenate) through the SW. Returns a Blob with `video/mp2t` MIME.
 */
async function fetchVideoViaWorker(masterUrl: string): Promise<Blob> {
	const res: FetchResponse | undefined = await chrome.runtime.sendMessage({
		type: 'sbpx-fetch-video',
		masterUrl,
	});
	if (!res) throw new Error('Extension service worker unavailable - try reloading the page.');
	if (!res.ok) throw new Error(res.error);
	return await materializeBlob(res);
}

// ---------- Bulk download orchestration ----------

/** Tell the browser to download a Blob with our chosen filename. */
function downloadBlob(filename: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sanitize a server-suggested filename so it's safe to use as a zip entry. */
function sanitizeFilename(name: string): string {
	const trimmed = name.replace(/[\\?%*:|"<>]/g, '_').trim();
	return trimmed !== '' ? trimmed : 'file';
}

/**
 * Resolve a media item's path inside the zip via the user's filename
 * template. Falls back to {@link MediaRef.suggestedFilename} when the
 * template renders to an empty string (defensive against an all-
 * unknown-placeholder template that the options page should have
 * rejected anyway).
 */
function applyFilenameTemplate(template: string, item: MediaRef, activity: ActivityRow | undefined): string {
	const dateTimeOriginal = item.dateTimeOriginal ?? '';
	const ctx: FilenameTemplateContext = {
		activityId: item.activityId,
		activityName: activity?.name ?? '',
		sport: activity?.sport_type ?? '',
		date: dateTimeOriginal.slice(0, 10),
		// EXIF DateTime format uses colons in time, which are illegal in
		// most filesystems - swap colons for dashes so a user template
		// like `{date_long}` doesn't produce an unsaveable path.
		dateLong: dateTimeOriginal.replace(/[:T]/g, '-').slice(0, 19),
		kind: item.mediaType,
		index: item.kindIndex,
		ext: item.ext,
	};
	const rendered = renderFilenameTemplate(template, ctx).trim();
	return rendered !== '' ? rendered : item.suggestedFilename;
}

/** Final result of a bulk run, plus the counts split by media type. */
export interface BulkResultDetailed extends BulkResult {
	photos: number;
	videos: number;
}

/**
 * Bulk download orchestrator. Discovers media across the selected
 * activities, fetches each item via the service worker, zips, and emits
 * the zip via a synthetic anchor click.
 *
 * Progress events fire as `{ stage: 'discovering' | 'downloading' | 'zipping' }`
 * exactly as before; the `downloading` counter spans both photos and
 * videos when `includeVideos` is true.
 *
 * Resolves with detailed per-kind counts. Returns `{ ok: 0, … }` when
 * no media was found (UI surfaces a "nothing found" warning).
 * Throws only if every fetched item failed.
 */
export async function downloadBulkPhotos(
	activities: ActivityRow[],
	{ includeVideos = false, onProgress, signal, forceFresh = false }: DownloadOptions = {},
): Promise<BulkResultDetailed> {
	if (activities.length === 0) return { ok: 0, photos: 0, videos: 0, activities: 0, failed: [], skippedHistory: 0 };

	// Load the saved-history set in parallel with discovery - it's a
	// single round-trip to chrome.storage.local that almost always
	// finishes before discovery's first /activities/<id> fetch. When
	// forceFresh is true we skip the storage read entirely so the bulk
	// run touches no metadata at all.
	const savedHistoryPromise: Promise<Set<string>> = forceFresh ? Promise.resolve(new Set()) : loadSavedMediaIds();
	// The filename template lives in chrome.storage.sync. Load it in
	// parallel with everything else; the value is rendered per-item just
	// before the zip add so a misconfigured template doesn't make us
	// drop fetched bytes on the floor.
	const filenameTemplatePromise: Promise<string> = loadFilenameTemplate();

	// Phase 1: discover. Parallel with a small concurrency cap and a
	// pre-sized result array so the final order matches the user's row
	// order in the table (which the per-activity directory naming inside
	// the zip relies on). Per-activity errors stay silent so one 404 in
	// a 50-activity run doesn't surface as a failure; AbortError from
	// the signal does propagate.
	onProgress?.({ stage: 'discovering', completed: 0, total: activities.length });
	const perActivityItems: MediaRef[][] = new Array<MediaRef[]>(activities.length);
	const discoverConcurrency = Math.min(3, activities.length);
	let discoverCursor = 0;
	let discovered = 0;
	await Promise.all(
		Array.from({ length: discoverConcurrency }, async () => {
			while (discoverCursor < activities.length) {
				signal?.throwIfAborted();
				const i = discoverCursor++;
				const activity = activities[i]!;
				try {
					const items = (await discoverMediaForActivity(activity, signal)).filter(
						(m) => m.mediaType === 'photo' || includeVideos,
					);
					perActivityItems[i] = items;
				} catch (e) {
					if ((e as Error)?.name === 'AbortError') throw e;
					perActivityItems[i] = [];
				}
				discovered++;
				onProgress?.({ stage: 'discovering', completed: discovered, total: activities.length });
			}
		}),
	);

	// Wait for the saved-history read to land before filtering. This
	// almost always resolved during discovery's first network round-trip
	// but the await keeps the contract obvious - we never start
	// downloading until we know what to skip.
	const savedHistory = await savedHistoryPromise;
	const filenameTemplate = await filenameTemplatePromise;

	const allMedia: MediaRef[] = [];
	const contributingActivities = new Set<string>();
	let skippedHistory = 0;
	for (let i = 0; i < perActivityItems.length; i++) {
		const items = perActivityItems[i] ?? [];
		if (items.length === 0) continue;
		const fresh: MediaRef[] = [];
		for (const item of items) {
			if (savedHistory.has(item.mediaId)) {
				skippedHistory++;
			} else {
				fresh.push(item);
			}
		}
		if (fresh.length > 0) {
			contributingActivities.add(activities[i]!.id);
			allMedia.push(...fresh);
		}
	}

	if (allMedia.length === 0) {
		return { ok: 0, photos: 0, videos: 0, activities: 0, failed: [], skippedHistory };
	}

	// Phase 2: download.
	const total = allMedia.length;
	const zip = new JSZip();
	const failed: BulkResultDetailed['failed'] = [];
	// Track which items actually landed in the zip so we can persist them
	// to chrome.storage.local after the run finishes. We mark items as
	// saved only AFTER the zip emits successfully, not per-item, so a
	// run that throws on zip generation doesn't leave history entries
	// claiming success.
	const succeededItems: { mediaId: string; activityId: string }[] = [];
	let completed = 0;
	let photoCount = 0;
	let videoCount = 0;
	onProgress?.({ stage: 'downloading', completed, total });

	// Concurrency: 4 for photo CDN, but videos serially because each
	// video is many sequential segment fetches inside the SW already.
	// We use a single shared cursor and let the SW serialize internally.
	const concurrency = 4;
	let cursor = 0;
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (cursor < total) {
				signal?.throwIfAborted();
				const i = cursor++;
				const item = allMedia[i]!;
				const activity = activities.find((a) => a.id === item.activityId);
				const activityName = activity?.name;
				try {
					const blob =
						item.mediaType === 'video'
							? await fetchVideoViaWorker(item.url)
							: await fetchPhotoViaWorker(item.url, {
									lat: item.lat,
									lng: item.lng,
									caption: item.caption,
									activityName,
									dateTimeOriginal: item.dateTimeOriginal,
								});
					zip.file(sanitizeFilename(applyFilenameTemplate(filenameTemplate, item, activity)), blob);
					succeededItems.push({ mediaId: item.mediaId, activityId: item.activityId });
					if (item.mediaType === 'video') videoCount++;
					else photoCount++;
				} catch (e) {
					if ((e as Error)?.name === 'AbortError') throw e;
					const message = e instanceof Error ? e.message : String(e);
					failed.push({ activityId: item.activityId, mediaUrl: item.url, reason: message });
				}
				completed++;
				onProgress?.({ stage: 'downloading', completed, total });
			}
		}),
	);

	signal?.throwIfAborted();
	const successCount = total - failed.length;
	if (successCount === 0) {
		throw new Error(`All ${total} downloads failed. First error: ${failed[0]?.reason ?? 'unknown'}`);
	}

	// Phase 3: zip + emit.
	onProgress?.({ stage: 'zipping' });
	const blob = await zip.generateAsync({
		type: 'blob',
		// Photos and videos are already compressed; store-only is faster
		// and yields the same output size as DEFLATE within rounding.
		compression: 'STORE',
	});
	// Filename rules:
	//   - one activity contributed     →  strava_media_<activity-id>.zip
	//   - many activities, photos only →  strava_photos_<date>.zip
	//   - many activities, with videos →  strava_media_<date>.zip
	let filename: string;
	if (contributingActivities.size === 1) {
		const [onlyId] = contributingActivities;
		filename = `strava_media_${onlyId}.zip`;
	} else {
		const date = new Date().toISOString().slice(0, 10);
		filename = videoCount > 0 ? `strava_media_${date}.zip` : `strava_photos_${date}.zip`;
	}
	downloadBlob(filename, blob);
	// If chrome.storage is unavailable we silently lose history for these
	// items, which is no worse than the pre-history behaviour.
	void markMediaIdsSaved(succeededItems);
	return {
		ok: successCount,
		photos: photoCount,
		videos: videoCount,
		activities: contributingActivities.size,
		failed,
		skippedHistory,
	};
}
