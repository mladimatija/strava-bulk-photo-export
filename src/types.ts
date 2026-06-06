/**
 * Shared types for the extension. Keeping them in one module avoids circular
 * imports between content.ts, photo-downloader.ts, and background.ts.
 */

/** An activity surfaced from a Strava table row into our toolbar/downloader. */
export interface ActivityRow {
	/** Numeric Strava activity id, kept as a string for stable map/set keys. */
	id: string;
	/** Title text extracted from the row's first activity link. */
	name: string;
	/** Sport label, e.g. "Run", "Hike", "Workout". Best-effort. */
	sport_type: string;
}

/** A single media item discovered on an activity page. */
export interface MediaRef {
	activityId: string;
	/** Stable id for the media item - Strava's photo_id or numeric id, stringified. */
	mediaId: string;
	mediaType: 'photo' | 'video';
	/**
	 * The URL we'll actually try to fetch. For photos this is the largest
	 * still-sized variant Strava exposes on the activity page (typically
	 * `…-2048xN.jpg`); the service worker will try the size-stripped bare
	 * URL first, falling back to this. For videos this is the master
	 * `.m3u8` playlist URL.
	 */
	url: string;
	/** Thumbnail URL. For videos this is the only non-streaming asset we can save. */
	thumbnailUrl?: string;
	/** GPS coordinates if Strava knows them - written into the JPEG's GPS EXIF. */
	lat?: number;
	lng?: number;
	/** User-provided caption text - written into the JPEG's ImageDescription EXIF. */
	caption?: string;
	/**
	 * Photo creation time as an ISO 8601 string (with or without trailing
	 * Z / timezone offset). When present, written into the JPEG's
	 * DateTimeOriginal / DateTimeDigitized / 0th.DateTime EXIF tags so
	 * photo libraries (Apple Photos, Lightroom) sort by when the
	 * activity happened rather than when the user exported. Strava
	 * exposes this on a few different keys per page bucket - prefer
	 * per-photo `created_at_local` / `created_at` when present, then fall
	 * back to the activity-level `start_date_local` / `start_date`.
	 */
	dateTimeOriginal?: string;
	/**
	 * 1-based counter within `mediaType` for this activity. Photos and
	 * videos are numbered independently, so a mixed activity reads as
	 * `photo-01.jpg, photo-02.jpg, video-01.ts` rather than interleaved.
	 * Read by the filename-template renderer at zip-emit time.
	 */
	kindIndex: number;
	/**
	 * File extension (without a dot) for this item, e.g. "jpg" or "ts".
	 * Snapshotted at discovery time so the template renderer doesn't
	 * have to re-derive it from the CDN URL.
	 */
	ext: string;
	/**
	 * Fallback path used when filename-template rendering fails or when
	 * a caller wants the default layout. The bulk downloader normally
	 * runs the configured template here, but the field stays around so
	 * the original behaviour is recoverable in tests and dev.
	 */
	suggestedFilename: string;
}

/** Per-media failure record returned by the bulk downloader. */
export interface BulkFailure {
	/** Activity id the media item belonged to. */
	activityId: string;
	/** Media URL (if available) - useful for tracking down which item failed. */
	mediaUrl?: string;
	reason: string;
}

/** Final result of a bulk download. */
export interface BulkResult {
	/** Count of media items successfully downloaded. */
	ok: number;
	/** Count of distinct activities that contributed at least one item. */
	activities: number;
	/** Per-media failures, in completion order. */
	failed: BulkFailure[];
	/**
	 * Count of media items skipped because a previous run already saved
	 * them (`chrome.storage.local` history). Always 0 when forceFresh is
	 * true. Surface in the UI so the user can tell "Saved 3 (skipped 47
	 * already in your downloads)" from "Saved 50".
	 */
	skippedHistory: number;
}

/**
 * Discriminated event the bulk downloader emits so the UI can show progress.
 *
 *   - 'discovering' - fetching the activity HTML and parsing media URLs.
 *   - 'downloading' - emitted before the first fetch and after every fetch
 *     completion (success or fail) with a running counter over total items.
 *   - 'zipping'     - emitted once when fetches are done and JSZip starts
 *     assembling the archive.
 */
export type ProgressEvent =
	| { stage: 'discovering'; completed: number; total: number }
	| { stage: 'downloading'; completed: number; total: number }
	| { stage: 'zipping' };

export type ProgressCallback = (event: ProgressEvent) => void;

/** Status kinds the toolbar can display. Maps to color via data-kind in CSS. */
export type StatusKind = '' | 'info' | 'ok' | 'warn' | 'err';

/** Options passed from the UI into the bulk downloader. */
export interface DownloadOptions {
	/** When true, include videos (HLS streams concatenated into one .ts file) alongside photos. */
	includeVideos?: boolean;
	onProgress?: ProgressCallback;
	/**
	 * Abort signal for cancelling a run in flight. When the signal fires
	 * the downloader aborts at the next safe boundary (between activities
	 * during discovery, between items during download) and throws a
	 * DOMException with `name === 'AbortError'`. Already-saved bytes are
	 * dropped (no partial zip emitted) - the caller can re-run to retry.
	 */
	signal?: AbortSignal;
	/**
	 * When true, re-download items previously marked saved in
	 * chrome.storage.local. Default false: items the user already has
	 * are silently skipped, which makes a re-run pick up where the
	 * last attempt left off. The skipped-count is reported back in
	 * BulkResult.skippedHistory.
	 */
	forceFresh?: boolean;
}
