// Background service worker. Handles every cross-origin fetch the content
// script needs (photos + HLS video segments), because in Manifest V3 content
// scripts inherit the host page's CORS context even when host_permissions
// declares the target origin. Service workers run in the extension's own
// origin and DO honor host_permissions, so they can fetch the photo and
// video CDNs without CORS interference.
//
// Two fetch request shapes:
//
//   { type: 'sbpx-fetch-photo', urlCandidates, metadata? }
//      Try each URL in order; first 200 wins. If `metadata` is provided
//      and the response is a JPEG, embed GPS + caption + activity name as
//      EXIF before returning the bytes.
//
//   { type: 'sbpx-fetch-video', masterUrl }
//      Fetch an HLS master playlist, pick the highest-bandwidth variant,
//      fetch all .ts segments, concatenate into a single MPEG-TS file.
//      The output plays in VLC/mpv/QuickTime; remux to .mp4 losslessly
//      with `ffmpeg -i file.ts -c copy file.mp4` if desired.
//
// Payloads are base64-encoded - `chrome.runtime.sendMessage` JSON-
// serializes everything it transports in MV3, so typed arrays don't
// survive the trip (they coerce to plain objects and the receiving Blob
// constructor turns them into literal "[object Object]" strings). base64
// is the only encoding that round-trips cleanly.
//
// `chrome.runtime.sendMessage` also caps a single message at 64 MiB. The
// SW therefore inlines the base64 when the raw payload fits comfortably
// under that ceiling, and otherwise hands back a `transferId` the content
// script polls with `sbpx-read-chunk` to stream the bytes back in pieces.
// See {@link TRANSFERS} below.

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
	/**
	 * ISO 8601 timestamp written into EXIF DateTimeOriginal +
	 * DateTimeDigitized + 0th.DateTime. Per-photo created_at when Strava
	 * exposes it; activity start time otherwise. See photo-downloader.ts
	 * for the priority chain.
	 */
	dateTimeOriginal?: string;
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
interface ReadChunkRequest {
	type: 'sbpx-read-chunk';
	transferId: string;
	offset: number;
}
interface ReleaseTransferRequest {
	type: 'sbpx-release-transfer';
	transferId: string;
}
type IncomingRequest = FetchPhotoRequest | FetchVideoRequest | ReadChunkRequest | ReleaseTransferRequest;

interface FetchPhotoInlineSuccess {
	ok: true;
	kind: 'photo';
	inline: true;
	base64: string;
	mimeType: string;
	fetchedUrl: string;
}
interface FetchPhotoChunkedSuccess {
	ok: true;
	kind: 'photo';
	inline: false;
	transferId: string;
	totalBytes: number;
	mimeType: string;
	fetchedUrl: string;
}
type FetchPhotoSuccess = FetchPhotoInlineSuccess | FetchPhotoChunkedSuccess;

interface FetchVideoInlineSuccess {
	ok: true;
	kind: 'video';
	inline: true;
	base64: string;
	mimeType: string;
	segmentCount: number;
}
interface FetchVideoChunkedSuccess {
	ok: true;
	kind: 'video';
	inline: false;
	transferId: string;
	totalBytes: number;
	mimeType: string;
	segmentCount: number;
}
type FetchVideoSuccess = FetchVideoInlineSuccess | FetchVideoChunkedSuccess;

interface ReadChunkSuccess {
	ok: true;
	base64: string;
	done: boolean;
	/**
	 * Absolute byte offset the next `sbpx-read-chunk` should ask for. Always
	 * `start + chunkSize` capped at `totalBytes`. Lets the content script
	 * pipeline the next request without knowing the SW-internal chunk size
	 * (which can be flipped at runtime via the test override).
	 */
	nextOffset: number;
}
interface ReleaseSuccess {
	ok: true;
}
interface FetchFailure {
	ok: false;
	error: string;
}
type ResponseEnvelope = FetchPhotoSuccess | FetchVideoSuccess | ReadChunkSuccess | ReleaseSuccess | FetchFailure;

function isIncomingRequest(x: unknown): x is IncomingRequest {
	if (typeof x !== 'object' || x === null) return false;
	const t = (x as { type?: unknown }).type;
	return (
		t === 'sbpx-fetch-photo' || t === 'sbpx-fetch-video' || t === 'sbpx-read-chunk' || t === 'sbpx-release-transfer'
	);
}

// Clicking the extension's toolbar icon opens the options page.
chrome.action.onClicked.addListener(() => {
	void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((req: unknown, _sender, sendResponse: (resp: ResponseEnvelope) => void) => {
	if (!isIncomingRequest(req)) return false;
	void (async () => {
		try {
			switch (req.type) {
				case 'sbpx-fetch-photo':
					sendResponse(await handlePhotoFetch(req));
					return;
				case 'sbpx-fetch-video':
					sendResponse(await handleVideoFetch(req));
					return;
				case 'sbpx-read-chunk':
					sendResponse(handleReadChunk(req));
					return;
				case 'sbpx-release-transfer':
					sendResponse(handleReleaseTransfer(req));
					return;
			}
		} catch (e) {
			sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	})();
	// Keep the channel open until the async sendResponse fires.
	return true;
});

// ---------- Chunked transfer state ----------

/**
 * Default per-message byte limit. `chrome.runtime.sendMessage` caps the
 * payload at 64 MiB; base64 grows the byte count by 4/3, so 24 MiB raw
 * comes out at ~32 MiB base64 - comfortably under the cap even with the
 * envelope overhead.
 */
const DEFAULT_CHUNK_SIZE = 24 * 1024 * 1024;

/**
 * Lifetime of a held transfer after the SW hands out a `transferId`. Five
 * minutes is plenty for a content script to drain even a slow chunked
 * read; anything older is almost certainly leaked (content script gone /
 * tab closed) and we drop the bytes to keep the SW from growing without
 * bound across a long Strava session.
 */
const TRANSFER_TTL_MS = 5 * 60 * 1000;

interface HeldTransfer {
	bytes: Uint8Array;
	mimeType: string;
	expiresAt: number;
}

const TRANSFERS = new Map<string, HeldTransfer>();

/**
 * Total bytes currently held across all chunked transfers. Capped so that a
 * user with five tabs each downloading a 100 MiB video can't make the SW
 * working set blow past Chrome's MV3 termination threshold (~30-50 MiB on
 * lower-end devices). When the cap is hit, we refuse to stash a new transfer
 * and surface a clear, actionable error to the user.
 */
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

function totalHeldBytes(): number {
	let total = 0;
	for (const t of TRANSFERS.values()) total += t.bytes.length;
	return total;
}

/**
 * Allow tests to lower the chunk threshold so the chunked path can be
 * exercised with a small fixture instead of a 24 MiB payload.
 *
 *   self.__sbpx_chunk_size_override = 256;
 *
 * Read at every response build so a test can flip it on, run, flip it off.
 */
function getChunkSize(): number {
	const o = (globalThis as { __sbpx_chunk_size_override?: number }).__sbpx_chunk_size_override;
	return typeof o === 'number' && o > 0 ? o : DEFAULT_CHUNK_SIZE;
}

function makeTransferId(): string {
	// `crypto.randomUUID()` is available in the MV3 service-worker context
	// (secure-origin extension page). 122 bits of entropy makes the id
	// effectively unguessable, which matters: any tab on strava.com can call
	// `sbpx-read-chunk` against any transferId.
	return `sbpx_${crypto.randomUUID()}`;
}

/**
 * Build the right response envelope for a finished fetch. Inline if the
 * bytes fit in one message; otherwise stash them under a new transferId
 * for the content script to drain in chunks.
 */
function buildPhotoResponse(
	bytes: Uint8Array,
	mimeType: string,
	fetchedUrl: string,
): FetchPhotoInlineSuccess | FetchPhotoChunkedSuccess | FetchFailure {
	const chunkSize = getChunkSize();
	if (bytes.length <= chunkSize) {
		return { ok: true, kind: 'photo', inline: true, base64: bytesToBase64(bytes), mimeType, fetchedUrl };
	}
	if (totalHeldBytes() + bytes.length > MAX_TRANSFER_BYTES) {
		return {
			ok: false,
			error: 'Too many concurrent large downloads. Wait for active downloads to finish, then try again.',
		};
	}
	const transferId = makeTransferId();
	TRANSFERS.set(transferId, { bytes, mimeType, expiresAt: Date.now() + TRANSFER_TTL_MS });
	scheduleTransferGc();
	return { ok: true, kind: 'photo', inline: false, transferId, totalBytes: bytes.length, mimeType, fetchedUrl };
}

function buildVideoResponse(
	bytes: Uint8Array,
	mimeType: string,
	segmentCount: number,
): FetchVideoInlineSuccess | FetchVideoChunkedSuccess | FetchFailure {
	const chunkSize = getChunkSize();
	if (bytes.length <= chunkSize) {
		return { ok: true, kind: 'video', inline: true, base64: bytesToBase64(bytes), mimeType, segmentCount };
	}
	if (totalHeldBytes() + bytes.length > MAX_TRANSFER_BYTES) {
		return {
			ok: false,
			error: 'Too many concurrent large downloads. Wait for active downloads to finish, then try again.',
		};
	}
	const transferId = makeTransferId();
	TRANSFERS.set(transferId, { bytes, mimeType, expiresAt: Date.now() + TRANSFER_TTL_MS });
	scheduleTransferGc();
	return { ok: true, kind: 'video', inline: false, transferId, totalBytes: bytes.length, mimeType, segmentCount };
}

let gcScheduled = false;
/**
 * Periodically prune expired transfers. Cheap: O(map size) once a minute,
 * and the map is empty whenever no large payload is in flight.
 */
function scheduleTransferGc(): void {
	if (gcScheduled) return;
	gcScheduled = true;
	setTimeout(() => {
		gcScheduled = false;
		const now = Date.now();
		for (const [id, t] of TRANSFERS) {
			if (t.expiresAt <= now) TRANSFERS.delete(id);
		}
		if (TRANSFERS.size > 0) scheduleTransferGc();
	}, 60 * 1000);
}

function handleReadChunk(req: ReadChunkRequest): ReadChunkSuccess | FetchFailure {
	const transfer = TRANSFERS.get(req.transferId);
	// MV3 service workers can be evicted between messages; when that happens
	// mid-drain the held bytes are gone and the content script's only safe
	// recovery is a full reload (the inline-or-stash decision was made by a
	// now-dead SW instance, so re-asking for the same transferId can't work).
	if (!transfer)
		return {
			ok: false,
			error: 'Download transfer lost (extension service worker was restarted). Reload the page and try again.',
		};
	const chunkSize = getChunkSize();
	const start = Math.max(0, req.offset);
	const end = Math.min(start + chunkSize, transfer.bytes.length);
	const slice = transfer.bytes.subarray(start, end);
	const done = end >= transfer.bytes.length;
	// Refresh TTL while the content script is actively draining.
	transfer.expiresAt = Date.now() + TRANSFER_TTL_MS;
	if (done) TRANSFERS.delete(req.transferId);
	return { ok: true, base64: bytesToBase64(slice), done, nextOffset: end };
}

function handleReleaseTransfer(req: ReleaseTransferRequest): ReleaseSuccess {
	TRANSFERS.delete(req.transferId);
	return { ok: true };
}

// ---------- Network helpers ----------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry on transient HTTP statuses (429 + 5xx) and network errors.
 * 4xx responses pass straight through so the caller can try the next
 * URL candidate (the bare → sized photo fallback relies on seeing 404s).
 *
 * Defaults: one retry, 500 ms initial backoff (1 s on attempt 2).
 */
async function fetchWithRetry(
	url: string,
	init?: RequestInit,
	{ retries = 1, baseDelayMs = 500 }: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
	let lastErr: unknown = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, init);
			if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < retries) {
				await sleep(baseDelayMs * 2 ** attempt);
				continue;
			}
			return res;
		} catch (e) {
			lastErr = e;
			if (attempt < retries) {
				await sleep(baseDelayMs * 2 ** attempt);
				continue;
			}
			throw e;
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error('fetch failed');
}

// ---------- Photo fetch ----------

async function handlePhotoFetch(req: FetchPhotoRequest): Promise<ResponseEnvelope> {
	let lastError = 'no candidates';
	for (const url of req.urlCandidates) {
		try {
			const res = await fetchWithRetry(url, { credentials: 'omit' });
			if (!res.ok) {
				lastError = `HTTP ${res.status}`;
				continue;
			}
			const blob = await res.blob();
			const buf = await blob.arrayBuffer();
			let bytes = new Uint8Array(buf);
			// Trust the server's MIME if it gave us a non-empty one; otherwise
			// sniff the first 4 bytes; otherwise punt to octet-stream. We
			// can't use `??` for blob.type because the fallback condition is
			// "empty string", not "null/undefined".
			const sniffed = guessMimeFromBytes(bytes.subarray(0, 4));
			const mimeType = blob.type !== '' ? blob.type : (sniffed ?? 'application/octet-stream');
			// Only attempt EXIF injection on real JPEGs. piexifjs silently
			// produces a broken file if you hand it PNG/HEIC/etc.
			if (req.metadata && isJpeg(bytes.subarray(0, 3))) {
				bytes = injectExif(bytes, req.metadata);
			}
			return buildPhotoResponse(bytes, mimeType, url);
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

// ---------- EXIF injection ----------

/**
 * Encode a Uint8Array as a "binary string" - one JS char per byte, every
 * char in 0x00-0xff. piexifjs operates on this representation internally.
 * Chunked so `String.fromCharCode(...big)` doesn't blow Chrome's argument-
 * count limit on multi-megabyte payloads.
 *
 * Memory note: this allocates a parts array of ~N/32k strings + the joined
 * full-length string + piexifjs's own copy, peaking at roughly 3x the input
 * size in transient memory. Acceptable for 4-8 MiB Strava JPEGs (24 MiB
 * peak); don't naively raise the inline chunk threshold without measuring
 * SW memory under load.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return parts.join('');
}

/**
 * Reverse of {@link bytesToBinaryString}. piexifjs's output is a "binary
 * string" where each char *should* be 0x00-0xff, but in some Chrome SW
 * contexts an occasional code point lands above 0xff (UTF-16 quirk in
 * piexif's internal string concat path). We truncate to the low byte
 * via `& 0xff`, matching Node's `Buffer.from(s, 'binary')` semantics -
 * the original code threw here instead, but every observed high char
 * has had the correct byte value in its low half, so throwing was
 * losing valid EXIF writes to false alarms.
 */
function binaryStringToBytes(s: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = s.charCodeAt(i) & 0xff;
	}
	return out;
}

/**
 * Convert an ISO 8601 timestamp to the EXIF DateTime string format
 * (`YYYY:MM:DD HH:MM:SS`). Accepts inputs with or without trailing `Z` /
 * timezone offset; the offset is dropped (EXIF has no TZ field). Returns
 * null if the input doesn't match the ISO date+time shape - the caller
 * skips the EXIF write in that case rather than emitting garbage.
 */
function formatExifDate(iso: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
	if (!m) return null;
	return `${m[1]}:${m[2]}:${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * Inject GPS + caption + software/description EXIF into a JPEG. Returns
 * the rewritten bytes on success, or the original bytes if anything goes
 * wrong - we'd rather ship a photo without metadata than lose the photo
 * entirely.
 *
 * piexifjs operates on binary strings (one JS char per byte). We translate
 * to/from `Uint8Array` at the seam; the throw inside
 * {@link binaryStringToBytes} catches any piexifjs output with multibyte
 * chars and the surrounding try/catch falls back to the original bytes.
 */
function injectExif(jpegBytes: Uint8Array<ArrayBuffer>, m: PhotoMetadata): Uint8Array<ArrayBuffer> {
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
			// Cap to ~1 KB so an unusually long Strava caption (the field
			// allows up to 2000 chars) can't produce an oversized
			// ImageDescription EXIF tag that some downstream parsers handle
			// poorly. ASCII captions truncate cleanly at the char boundary;
			// the value isn't load-bearing for any downstream consumer.
			zeroth[piexif.ImageIFD.ImageDescription] =
				description.length > 1024 ? `${description.slice(0, 1021)}...` : description;
		}

		const exifObj: ExifObject = { '0th': zeroth };

		// DateTime / DateTimeOriginal / DateTimeDigitized are all in the
		// EXIF format `YYYY:MM:DD HH:MM:SS` (note colons in date, not
		// hyphens). EXIF has no timezone field, so the format encodes
		// "local clock time" - we strip any TZ suffix Strava put on the
		// ISO string. Apple Photos / Lightroom both use these tags to
		// drive the photo timeline, so writing them gets activity photos
		// sorting by activity date instead of export date.
		const exifDate = m.dateTimeOriginal ? formatExifDate(m.dateTimeOriginal) : null;
		if (exifDate) {
			zeroth[piexif.ImageIFD.DateTime] = exifDate;
			exifObj.Exif = {
				[piexif.ExifIFD.DateTimeOriginal]: exifDate,
				[piexif.ExifIFD.DateTimeDigitized]: exifDate,
			};
		}

		// Only build a GPS IFD if we actually have coords. Passing piexifjs
		// an empty GPS object produces a malformed EXIF block on some inputs.
		if (typeof m.lat === 'number' && typeof m.lng === 'number' && Number.isFinite(m.lat) && Number.isFinite(m.lng)) {
			const gps: Record<number, unknown> = {};
			gps[piexif.GPSIFD.GPSLatitudeRef] = m.lat >= 0 ? 'N' : 'S';
			gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(m.lat));
			gps[piexif.GPSIFD.GPSLongitudeRef] = m.lng >= 0 ? 'E' : 'W';
			gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(m.lng));
			exifObj.GPS = gps;
		}

		// Nothing useful to write? Don't bother round-tripping the bytes
		if (Object.keys(zeroth).length === 1 && !exifObj.GPS && !exifObj.Exif) {
			// Only the `Software` tag, which isn't worth a re-encode by itself.
			return jpegBytes;
		}

		const exifBinary = piexif.dump(exifObj);
		const jpegBinary = bytesToBinaryString(jpegBytes);
		const newJpegBinary = piexif.insert(exifBinary, jpegBinary);
		return binaryStringToBytes(newJpegBinary);
	} catch {
		return jpegBytes;
	}
}

// ---------- HLS video fetch ----------

async function handleVideoFetch(req: FetchVideoRequest): Promise<ResponseEnvelope> {
	const { bytes, segmentCount } = await fetchHls(req.masterUrl);
	return buildVideoResponse(bytes, 'video/mp2t', segmentCount);
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
async function fetchHls(initialUrl: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; segmentCount: number }> {
	const firstRes = await fetchWithRetry(initialUrl, { credentials: 'omit' });
	if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status}`);
	const firstText = await firstRes.text();
	let parsed = parseM3u8(firstText, initialUrl);

	if (parsed.variants.length > 0 && parsed.segments.length === 0) {
		// Master playlist - resolve to a media playlist.
		const best = parsed.variants.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b));
		const mediaRes = await fetchWithRetry(best.url, { credentials: 'omit' });
		if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status}`);
		const mediaText = await mediaRes.text();
		parsed = parseM3u8(mediaText, best.url);
	}

	if (parsed.segments.length === 0) {
		throw new Error('no HLS segments found');
	}

	// Fetch all segments in parallel with a small concurrency cap so a
	// minute-long video at ~6 s segments doesn't pay 10× the round-trip
	// time it has to. Pre-sized array + indexed writes preserve playback
	// order regardless of completion order; a single shared cursor feeds
	// the workers so we don't burn workers on already-claimed segments.
	const totalSegments = parsed.segments.length;
	const chunks: Uint8Array[] = new Array<Uint8Array>(totalSegments);
	const segmentConcurrency = Math.min(4, totalSegments);
	let segmentCursor = 0;
	await Promise.all(
		Array.from({ length: segmentConcurrency }, async () => {
			while (segmentCursor < totalSegments) {
				const i = segmentCursor++;
				const url = parsed.segments[i]!;
				const res = await fetchWithRetry(url, { credentials: 'omit' });
				if (!res.ok) throw new Error(`segment HTTP ${res.status}`);
				const buf = await res.arrayBuffer();
				chunks[i] = new Uint8Array(buf);
			}
		}),
	);
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
 */
function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
	}
	return btoa(parts.join(''));
}
