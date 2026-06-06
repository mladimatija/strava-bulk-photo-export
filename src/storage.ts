// Persistent "what we've already saved" record. Lets a bulk re-run skip
// items the user has already downloaded - the difference between
// starting a bulk photo export from zero every time and resuming from
// where the last attempt left off.
//
// Stored in `chrome.storage.local` (per-profile, per-extension, NOT
// synced across devices). Bounded by a 30-day TTL: entries older than
// that are pruned on every load, so the map can't grow without bound
// across a long Strava lifetime. The mediaId is Strava's stable
// `photo_id` / `id` for the media item, so a re-fetched page with the
// same photo collapses to a no-op.

const STORAGE_KEY = 'sbpx_saved_v1';

/** TTL for individual entries. Anything older is dropped on the next load. */
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SavedEntry {
	savedAt: number;
	activityId: string;
}

type SavedMap = Record<string, SavedEntry>;

interface StoredShape {
	[STORAGE_KEY]?: SavedMap;
}

/** True iff `chrome.storage.local` is available in the current context. */
function storageAvailable(): boolean {
	return typeof chrome !== 'undefined' && chrome.storage?.local !== undefined;
}

/**
 * Load the set of mediaIds that previous runs successfully saved.
 * Prunes stale entries inline so the map can't grow forever. Returns
 * an empty Set when chrome.storage is unavailable (tests, dev, an
 * unexpected permission failure) - the downloader treats that as
 * "nothing previously saved" and runs as before.
 */
export async function loadSavedMediaIds(): Promise<Set<string>> {
	if (!storageAvailable()) return new Set();
	try {
		const got: StoredShape = await chrome.storage.local.get(STORAGE_KEY);
		const map = got[STORAGE_KEY] ?? {};
		const now = Date.now();
		const fresh: SavedMap = {};
		for (const [id, entry] of Object.entries(map)) {
			if (now - entry.savedAt < ENTRY_TTL_MS) {
				fresh[id] = entry;
			}
		}
		// Write back only if we actually dropped anything, to avoid a
		// pointless write on every load.
		if (Object.keys(fresh).length !== Object.keys(map).length) {
			void chrome.storage.local.set({ [STORAGE_KEY]: fresh });
		}
		return new Set(Object.keys(fresh));
	} catch {
		return new Set();
	}
}

/**
 * Record one or more mediaIds as successfully saved. Batched so a
 * 200-item bulk run does ONE storage write at the end instead of 200
 * mid-flight.
 */
export async function markMediaIdsSaved(items: { mediaId: string; activityId: string }[]): Promise<void> {
	if (items.length === 0 || !storageAvailable()) return;
	try {
		const got: StoredShape = await chrome.storage.local.get(STORAGE_KEY);
		const map = got[STORAGE_KEY] ?? {};
		const now = Date.now();
		for (const item of items) {
			map[item.mediaId] = { savedAt: now, activityId: item.activityId };
		}
		await chrome.storage.local.set({ [STORAGE_KEY]: map });
	} catch {
		// Silent: if storage is unavailable, the run still completes -
		// we just can't skip these items next time. Better than failing
		// the whole download for a metadata bookkeeping error.
	}
}

/**
 * Clear the entire saved-history map. Not wired into the UI yet -
 * exposed for a future "Reset history" affordance and for tests that
 * need a clean slate between runs.
 */
export async function resetSavedHistory(): Promise<void> {
	if (!storageAvailable()) return;
	try {
		await chrome.storage.local.remove(STORAGE_KEY);
	} catch {
		/* silent */
	}
}
