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
	/** Path inside the output zip, e.g. `18437723885/photo-01.jpg`. */
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
}
