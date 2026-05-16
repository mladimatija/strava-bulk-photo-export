// Background service worker. Handles every cross-origin fetch the content
// script needs (photos + HLS video segments), because in Manifest V3 content
// scripts inherit the host page's CORS context even when host_permissions
// declares the target origin. Service workers run in the extension's own
// origin and DO honor host_permissions, so they can fetch the photo and
// video CDNs without CORS interference.
//
// Two request shapes:
//
//   { type: 'sbpx-fetch-photo', urlCandidates, metadata? }
//      Try each URL in order; first 200 wins. If `metadata` is provided
//      and the response is a JPEG, embed GPS + caption + activity name as
//      EXIF before returning the bytes.
//      Response: { ok: true, base64, mimeType, fetchedUrl }
//
//   { type: 'sbpx-fetch-video', masterUrl }
//      Fetch an HLS master playlist, pick the highest-bandwidth variant,
//      fetch all .ts segments, concatenate into a single MPEG-TS file.
//      The output plays in VLC/mpv/QuickTime; remux to .mp4 losslessly
//      with `ffmpeg -i file.ts -c copy file.mp4` if desired.
//      Response: { ok: true, base64, mimeType: 'video/mp2t', segmentCount }
//
// All payloads round-trip as base64 strings because `chrome.runtime.sendMessage`
// serializes to JSON and Blob/ArrayBuffer don't survive that.

import piexif from 'piexifjs';

// piexifjs ships types via `@types/piexifjs`, but the `ExifDict` interface is
// nested under a `Piexif` namespace that can't be named directly with a
// `verbatimModuleSyntax`-friendly named import (`export = Piexif` style).
// Reaching for it via `Parameters<typeof piexif.dump>[0]` gives us the exact
// same type back without dragging in a second import form.
type ExifObject = Parameters<typeof piexif.dump>[0];

interface PhotoMetadata {
	lat?: number;
	lng?: number;
	caption?: string;
	activityName?: string;
}

interface FetchPhotoRequest {
	type: 'sbpx-fetch-photo';
	urlCandidates: string[];
	metadata?: PhotoMetadata;
}
interface FetchVideoRequest {
	type: 'sbpx-fetch-video';
	masterUrl: string;
}
type FetchRequest = FetchPhotoRequest | FetchVideoRequest;

interface FetchPhotoSuccess {
	ok: true;
	kind: 'photo';
	base64: string;
	mimeType: string;
	fetchedUrl: string;
}
interface FetchVideoSuccess {
	ok: true;
	kind: 'video';
	base64: string;
	mimeType: string;
	segmentCount: number;
}
interface FetchFailure {
	ok: false;
	error: string;
}
type FetchResponse = FetchPhotoSuccess | FetchVideoSuccess | FetchFailure;

function isFetchRequest(x: unknown): x is FetchRequest {
	if (typeof x !== 'object' || x === null) return false;
	const o = x as { type?: unknown };
	return o.type === 'sbpx-fetch-photo' || o.type === 'sbpx-fetch-video';
}

chrome.runtime.onMessage.addListener((req: unknown, _sender, sendResponse: (resp: FetchResponse) => void) => {
	if (!isFetchRequest(req)) return false;
	void (async () => {
		try {
			if (req.type === 'sbpx-fetch-photo') {
				sendResponse(await handlePhotoFetch(req));
			} else {
				sendResponse(await handleVideoFetch(req));
			}
		} catch (e) {
			sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	})();
	// Keep the channel open until the async sendResponse fires.
	return true;
});

// ---------- Photo fetch ----------

async function handlePhotoFetch(req: FetchPhotoRequest): Promise<FetchResponse> {
	let lastError = 'no candidates';
	for (const url of req.urlCandidates) {
		try {
			const res = await fetch(url, { credentials: 'omit' });
			if (!res.ok) {
				lastError = `HTTP ${res.status}`;
				continue;
			}
			const blob = await res.blob();
			const buf = await blob.arrayBuffer();
			const bytes = new Uint8Array(buf);
			let base64 = bytesToBase64(bytes);
			// Trust the server's MIME if it gave us a non-empty one; otherwise
			// sniff the first 4 bytes; otherwise punt to octet-stream. We
			// can't use `??` for blob.type because the fallback condition is
			// "empty string", not "null/undefined".
			const sniffed = guessMimeFromBytes(bytes.subarray(0, 4));
			const mimeType = blob.type !== '' ? blob.type : (sniffed ?? 'application/octet-stream');
			// Only attempt EXIF injection on real JPEGs. piexifjs silently
			// produces a broken file if you hand it PNG/HEIC/etc.
			if (req.metadata && isJpeg(bytes.subarray(0, 3))) {
				base64 = injectExif(base64, req.metadata);
			}
			return { ok: true, kind: 'photo', base64, mimeType, fetchedUrl: url };
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	return { ok: false, error: lastError };
}

function isJpeg(firstBytes: Uint8Array): boolean {
	return firstBytes[0] === 0xff && firstBytes[1] === 0xd8 && firstBytes[2] === 0xff;
}

function guessMimeFromBytes(firstBytes: Uint8Array): string | null {
	if (isJpeg(firstBytes)) return 'image/jpeg';
	if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4e && firstBytes[3] === 0x47)
		return 'image/png';
	if (firstBytes[0] === 0x47 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) return 'image/gif';
	if (firstBytes[0] === 0x52 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46 && firstBytes[3] === 0x46)
		return 'image/webp';
	return null;
}

/** base64 alphabet check used to validate piexifjs output. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Inject GPS + caption + software/description EXIF into a base64 JPEG.
 * Returns the rewritten base64 on success, or the original base64 if
 * anything goes wrong - we'd rather ship a photo without metadata than
 * lose the photo entirely.
 *
 * Implementation note: piexifjs supports two input shapes - data URLs
 * (`data:image/jpeg;base64,…`) and raw binary strings. The data-URL path
 * has been observed to occasionally return malformed output for some
 * Strava JPEGs (the resulting "data URL" carries chars that aren't valid
 * base64), which then makes the content script's `atob` call throw.
 * We use the binary-string round-trip here instead - it goes through
 * piexifjs's internal `atob`/`btoa` pair as a pure pipeline, and the
 * final `btoa` always produces clean base64.
 */
function injectExif(jpegBase64: string, m: PhotoMetadata): string {
	try {
		const zeroth: Record<number, unknown> = {};
		zeroth[piexif.ImageIFD.Software] = 'Strava Bulk Photo Export';
		// Caption goes into ImageDescription (broadly compatible). If we
		// have an activity name AND a caption, prefer the caption since
		// it's user-authored; otherwise fall back to the activity name.
		// We need explicit emptiness checks (not `??`) because trimmed
		// strings can be `''`, which is falsy but not nullish.
		const captionTrimmed = m.caption?.trim() ?? '';
		const activityNameTrimmed = m.activityName?.trim() ?? '';
		const description = captionTrimmed !== '' ? captionTrimmed : activityNameTrimmed;
		if (description !== '') {
			zeroth[piexif.ImageIFD.ImageDescription] = description;
		}

		// Only build a GPS IFD if we actually have coords. Passing piexifjs
		// an empty GPS object produces a malformed EXIF block on some inputs.
		const exifObj: ExifObject = { '0th': zeroth };
		if (typeof m.lat === 'number' && typeof m.lng === 'number' && Number.isFinite(m.lat) && Number.isFinite(m.lng)) {
			const gps: Record<number, unknown> = {};
			gps[piexif.GPSIFD.GPSLatitudeRef] = m.lat >= 0 ? 'N' : 'S';
			gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(m.lat));
			gps[piexif.GPSIFD.GPSLongitudeRef] = m.lng >= 0 ? 'E' : 'W';
			gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(m.lng));
			exifObj.GPS = gps;
		}

		// Nothing useful to write? Don't bother round-tripping the bytes
		if (Object.keys(zeroth).length === 1 && !exifObj.GPS) {
			// Only the `Software` tag, which isn't worth a re-encode by itself.
			return jpegBase64;
		}

		const exifBinary = piexif.dump(exifObj);
		// Binary-string round-trip. piexifjs detects "no data URL prefix"
		// and returns binary; we re-encode with btoa to guaranteed clean base64.
		const jpegBinary = atob(jpegBase64);
		const newJpegBinary = piexif.insert(exifBinary, jpegBinary);
		const newBase64 = btoa(newJpegBinary);
		// If the output isn't clean base64 (piexifjs quirk on
		// malformed JPEGs), fall back to the original bytes so the photo
		// still ships, just without EXIF.
		return BASE64_RE.test(newBase64) ? newBase64 : jpegBase64;
	} catch {
		return jpegBase64;
	}
}

// ---------- HLS video fetch ----------

async function handleVideoFetch(req: FetchVideoRequest): Promise<FetchResponse> {
	const { bytes, segmentCount } = await fetchHls(req.masterUrl);
	return { ok: true, kind: 'video', base64: bytesToBase64(bytes), mimeType: 'video/mp2t', segmentCount };
}

interface ParsedM3u8 {
	variants: { url: string; bandwidth: number }[];
	segments: string[];
}

/**
 * Parse an `.m3u8` playlist. Returns a list of variant streams (if this
 * is a master playlist) or a list of segment URLs (if this is a media
 * playlist); typically one or the other is populated, not both.
 * Relative URLs are resolved against `baseUrl`.
 */
function parseM3u8(text: string, baseUrl: string): ParsedM3u8 {
	const variants: ParsedM3u8['variants'] = [];
	const segments: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? '').trim();
		if (!line) continue;
		if (line.startsWith('#EXT-X-STREAM-INF')) {
			const bwMatch = /BANDWIDTH=(\d+)/i.exec(line);
			const target = (lines[i + 1] ?? '').trim();
			if (target && !target.startsWith('#')) {
				variants.push({
					url: new URL(target, baseUrl).href,
					bandwidth: bwMatch?.[1] ? Number(bwMatch[1]) : 0,
				});
			}
		} else if (line.startsWith('#EXTINF')) {
			const target = (lines[i + 1] ?? '').trim();
			if (target && !target.startsWith('#')) {
				segments.push(new URL(target, baseUrl).href);
			}
		}
	}
	return { variants, segments };
}

/**
 * Download an HLS stream as a single MPEG-TS blob:
 *   1. Fetch the playlist Strava points us at.
 *   2. If it's a master playlist, pick the highest-bandwidth variant and
 *      fetch THAT playlist.
 *   3. Fetch every `.ts` segment, concatenate them in order.
 *
 * The output container is MPEG-TS (`video/mp2t`). Most desktop video players
 * (VLC, mpv, QuickTime with the right extension) play this directly;
 * `ffmpeg -i out.ts -c copy out.mp4` is a lossless remux to MP4.
 */
async function fetchHls(initialUrl: string): Promise<{ bytes: Uint8Array; segmentCount: number }> {
	const firstRes = await fetch(initialUrl, { credentials: 'omit' });
	if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status}`);
	const firstText = await firstRes.text();
	let parsed = parseM3u8(firstText, initialUrl);

	if (parsed.variants.length > 0 && parsed.segments.length === 0) {
		// Master playlist - resolve to a media playlist.
		const best = parsed.variants.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b));
		const mediaRes = await fetch(best.url, { credentials: 'omit' });
		if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status}`);
		const mediaText = await mediaRes.text();
		parsed = parseM3u8(mediaText, best.url);
	}

	if (parsed.segments.length === 0) {
		throw new Error('no HLS segments found');
	}

	// Fetch all segments. Sequential for now - HLS segments are small
	// (~6 s each), and the user-perceived wait is usually short. If we ever
	// need to speed this up, batch into a concurrency-limited Promise.all().
	const chunks: Uint8Array[] = [];
	for (const url of parsed.segments) {
		const res = await fetch(url, { credentials: 'omit' });
		if (!res.ok) throw new Error(`segment HTTP ${res.status}`);
		const buf = await res.arrayBuffer();
		chunks.push(new Uint8Array(buf));
	}
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return { bytes: merged, segmentCount: parsed.segments.length };
}

// ---------- base64 helpers ----------

/**
 * Encode a Uint8Array as base64 using `btoa` on a binary string. We chunk
 * the conversion because `String.fromCharCode(...verylargearray)` blows
 * Chrome's argument-count limit on multi-megabyte payloads.
 *
 * Takes a Uint8Array (not an ArrayBuffer) so callers don't have to deal
 * with the ArrayBuffer / SharedArrayBuffer split that `TypedArray.buffer`
 * now exposes under modern lib.dom.d.ts.
 */
function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return btoa(parts.join(''));
}
