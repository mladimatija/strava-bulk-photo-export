// Persistent storage for two kinds of state:
//
//   1. Saved-history (chrome.storage.local). Records which mediaIds the
//      user has already downloaded so a re-run can skip them. Local
//      because it's a per-machine, per-profile bookkeeping artifact
//      that has no meaning on another device.
//
//   2. Filename template (chrome.storage.sync). The pattern used to
//      derive the path of each item inside the zip. Sync because it's
//      a preference - if the user spends time getting
//      "{date}/{sport}/{activity_name}-{index}.{ext}" right on their
//      desktop, they shouldn't have to redo it on their laptop.
//
// Both layers gracefully no-op when `chrome.storage` is unavailable
// (tests, dev contexts, an unexpected permission failure) - callers
// treat that as "use defaults".

import { DEFAULT_FILENAME_TEMPLATE } from './filename-template.ts';

const STORAGE_KEY = 'sbpx_saved_v1';
const TEMPLATE_KEY = 'sbpx_filename_template_v1';

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
		let dropped = 0;
		for (const [id, entry] of Object.entries(map)) {
			if (now - entry.savedAt < ENTRY_TTL_MS) {
				fresh[id] = entry;
			} else {
				dropped++;
			}
		}
		// Write back only if we actually dropped anything, to avoid a
		// pointless write on every load.
		if (dropped > 0) {
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

// ---------- Filename template ----------

interface TemplateStoredShape {
	[TEMPLATE_KEY]?: string;
}

/** True iff `chrome.storage.sync` is available in the current context. */
function syncStorageAvailable(): boolean {
	return typeof chrome !== 'undefined' && chrome.storage?.sync !== undefined;
}

/**
 * Load the filename template the user configured on the options page,
 * or {@link DEFAULT_FILENAME_TEMPLATE} when storage is unavailable /
 * empty. Strings are trimmed on the way out so a stray trailing space
 * doesn't accumulate as an empty filename component.
 */
export async function loadFilenameTemplate(): Promise<string> {
	if (!syncStorageAvailable()) return DEFAULT_FILENAME_TEMPLATE;
	try {
		const got: TemplateStoredShape = await chrome.storage.sync.get(TEMPLATE_KEY);
		const stored = got[TEMPLATE_KEY]?.trim();
		return stored !== undefined && stored.length > 0 ? stored : DEFAULT_FILENAME_TEMPLATE;
	} catch {
		return DEFAULT_FILENAME_TEMPLATE;
	}
}

/**
 * Persist the user's filename template. Empty / whitespace-only input
 * is treated as "reset to default" - it's the same result the user
 * would get by manually clicking Reset and saves an extra round-trip.
 *
 * Throws on storage failure so the options page can show the error
 * instead of silently confirming a save that never happened. Callers
 * that want fire-and-forget semantics (e.g. tests, dev contexts where
 * sync is unavailable) should catch.
 */
export async function saveFilenameTemplate(template: string): Promise<void> {
	if (!syncStorageAvailable()) return;
	const trimmed = template.trim();
	if (trimmed === '' || trimmed === DEFAULT_FILENAME_TEMPLATE) {
		await chrome.storage.sync.remove(TEMPLATE_KEY);
		return;
	}
	await chrome.storage.sync.set({ [TEMPLATE_KEY]: trimmed });
}
