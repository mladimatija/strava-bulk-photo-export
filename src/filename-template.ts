// Filename template engine. Users configure a template string in the
// options page; we substitute whitelisted `{variable}` placeholders to
// derive the path each media item takes inside the zip.
//
// The whitelist is deliberately small (8 variables) so the surface stays
// predictable - an unknown `{foo}` is left as a literal "{foo}" rather
// than collapsing to empty, which makes typos visible to the user
// instead of silently disappearing.
//
// Sanitization happens in two layers:
//   1. Per-component sanitization here strips characters that can't
//      legally appear in a filename component (path separators, control
//      chars, quotes, etc.) before substitution. Otherwise an activity
//      named "12/5 long run" would silently inject a path component.
//   2. The whole rendered path then passes through the existing
//      sanitizeFilename in photo-downloader.ts which handles any leftover
//      hazards (leading dots, etc.). The two layers are intentional - the
//      per-component pass is for sanitisation, the whole-string pass for
//      zip-entry safety.

/**
 * Default template - matches the pre-template hard-coded behaviour
 * exactly. New users land here; existing zips look identical to what
 * they got before this feature shipped.
 */
export const DEFAULT_FILENAME_TEMPLATE = '{activity_id}/{kind}-{index}.{ext}';

/** Variables a template can reference; passed to {@link renderFilenameTemplate}. */
export interface FilenameTemplateContext {
	/** Strava activity id, e.g. "18437723885". */
	activityId: string;
	/** Activity name from the row link, e.g. "Morning Run". */
	activityName: string;
	/** Sport label, e.g. "Run", "Hike". May be empty. */
	sport: string;
	/** "YYYY-MM-DD" derived from the photo/activity start time. Empty if unknown. */
	date: string;
	/** "YYYY-MM-DDTHH-MM-SS" form (colons replaced with dashes for filename safety). Empty if unknown. */
	dateLong: string;
	/** Photo or video. */
	kind: 'photo' | 'video';
	/** 1-based counter within `kind` for this activity. Padded by the template (e.g. `{index}` → "01"). */
	index: number;
	/** File extension WITHOUT a leading dot. e.g. "jpg", "ts". */
	ext: string;
}

/**
 * Strip characters that have no business inside a filename component.
 * Forward slashes are preserved in the WHOLE template (they create
 * subdirectories inside the zip) but NOT in a substituted value, where
 * a slash in an activity name would silently re-shape the layout.
 */
function sanitizeComponent(value: string): string {
	return (
		value
			// Path separators: turn into _ rather than collapse them
			// out, so "12/5 run" → "12_5 run" remains legible.
			.replace(/[\\/]/g, '_')
			// Characters that some filesystems reject outright.
			.replace(/[:*?"<>|]/g, '_')
			// Control characters - inline disable because the codepoints
			// are exactly what we're trying to strip.
			// eslint-disable-next-line no-control-regex
			.replace(/[\x00-\x1f]/g, '')
			.trim()
	);
}

/**
 * Render a filename template against the given context. Unknown
 * placeholders pass through as literals so the user can spot typos
 * (e.g. "{actvity_id}" stays in the path instead of becoming "").
 *
 * `{index}` zero-pads to 2 digits by default. To use a different width
 * write `{index:N}` (e.g. `{index:4}` for "0001"). The width is clamped
 * to [1, 6] - anything else falls back to 2 - so a hostile template
 * can't blow filename length on a huge run.
 */
export function renderFilenameTemplate(template: string, ctx: FilenameTemplateContext): string {
	return template.replace(/\{(\w+)(?::(\d+))?\}/g, (match, name: string, width?: string) => {
		switch (name) {
			case 'activity_id':
				return sanitizeComponent(ctx.activityId);
			case 'activity_name':
				return sanitizeComponent(ctx.activityName);
			case 'sport':
				return sanitizeComponent(ctx.sport);
			case 'date':
				return sanitizeComponent(ctx.date);
			case 'date_long':
				return sanitizeComponent(ctx.dateLong);
			case 'kind':
				return ctx.kind;
			case 'index': {
				const w = width === undefined ? 2 : Math.min(6, Math.max(1, Number(width)));
				const pad = Number.isFinite(w) && w > 0 ? w : 2;
				return String(ctx.index).padStart(pad, '0');
			}
			case 'ext':
				return ctx.ext.replace(/[^a-z0-9]/gi, '');
			default:
				return match;
		}
	});
}
