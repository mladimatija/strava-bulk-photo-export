# Changelog

All notable changes will be documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are SemVer.

## [1.0.1] - 2026-06-07

### Fixed

- **Path traversal in zip entries.** `sanitizeFilename` now drops empty, `.`, and `..` segments from the rendered template path so a hostile activity name or template can't produce an unsafe entry like `/../foo`. JSZip neutralised these in practice, but leaning on that for path safety was fragile.
- **Service-worker eviction mid-drain.** When the MV3 SW is evicted while a chunked transfer is in flight, the content script surfaces an actionable "Download transfer lost – reload the page" status instead of the cryptic `transfer expired or unknown`.
- **Videos + saved-history status mis-label.** A bulk run that included videos AND skipped saved-history items was being reported as photos-only because the skipped-history branch took priority. The terminal-status helper now picks videos > skipped-history > photos-only.

### Changed

- **Chunked SW → content transport is pipelined.** The next `sbpx-read-chunk` request is dispatched before decoding the current slice's base64. For a 100 MiB video this roughly halves effective transport overhead.
- **`allAlreadySaved` status surfaces the skip count.** Reads "Nothing new to save – all N selected items are already in your downloads." Translated across all 15 locales.
- **Options-page save failures are surfaced inline.** `chrome.storage.sync` errors (quota exceeded, runtime gone) no longer silently swallow; the new `optionsSaveFailed` string is shown next to Save.
- **Multi-tab SW memory cap.** A 64 MiB cap on total held chunked transfers prevents a user with multiple tabs from blowing past Chrome's MV3 SW eviction threshold; over-cap requests return a clear "wait for in-flight downloads to finish" error.
- **EXIF `ImageDescription` is capped at 1024 chars** with a `…` truncation tail to defend oversized APP1 tags against downstream EXIF parsers.
- **`transferId` uses `crypto.randomUUID()`** instead of `Math.random` — 122 bits of entropy makes the id unguessable.
- **Download loop indexes activities by id.** A single `Map` lookup replaces `Array.find` per media item; matters at the 50-activity / 200-photo end of the range.

### Internal

- New E2E coverage: per-photo `created_at_local` EXIF priority, parallel activity discovery, `fetchWithRetry` 503 → 200 retry, path-traversal sanitization, options-page error branch.
- `waitForZipBytes` test helper uses `expect.poll` instead of a `Date.now` / `waitForTimeout` deadline race.
- Cleanup: dead `Number.isFinite` guard in filename-template `{index}` padding; double `Object.keys().length` call in saved-history prune.

## [1.0.0] - 2026-05-14

Initial public release.

### Added

- **Per-row export.** Each row in `https://www.strava.com/athlete/training` gets a **Photos** button at the end that downloads every photo attached to that activity. Indoor activities are not excluded - they can still have photos attached.
- **Bulk export.** Multi-select checkboxes plus a **Download photos** button in the toolbar. Multi-row selection produces a single `.zip` named `strava_photos_<date>.zip`, one folder per activity, original-resolution photos where Strava exposes them.
- **Single-activity page toolbar.** The same toolbar mounts beneath the photo thumbnails inside `#activity-photos-container` on `/activities/<id>` pages. Select-all and the count widget are omitted because the activity is implicit from the URL; the primary Download photos button starts enabled. One-click downloads the activity's media as `strava_media_<activity-id>.zip`. In single mode a long terminal status drops onto its own wrapped row beneath the controls, so it never gets clipped; the row collapses when the message is empty.
- **Max-resolution probe.** The service worker tries the size-stripped (bare) photo URL before falling back to the `-2048xN` variant Strava renders on the page, so you get the upload original whenever the CDN serves it.
- **EXIF metadata preserved.** GPS coordinates, caption, and the activity name are written back into each downloaded JPEG via `piexifjs`. Photo-library apps (Apple Photos, Lightroom, etc.) pick up the GPS pin and description automatically. Non-JPEG responses pass through untouched.
- **Video download (optional).** Toolbar "Include videos" checkbox - when on, HLS streams (`.m3u8` + `.ts` segments) are downloaded by the service worker, concatenated into a single MPEG-TS file per video, and bundled alongside photos in the zip (`<activity-id>/video-NN.ts`). `ffmpeg -i video-01.ts -c copy video-01.mp4` losslessly remuxes to MP4 if you prefer that container. When videos are included the output filename switches to `strava_media_<date>.zip`.
- **JSON-based discovery.** Activity pages embed photo and video data as a React-props JSON blob; the extension parses that directly (with a regex fallback) instead of guessing from HTML. Cleaner, faster, and gives us structured metadata for the EXIF step.
- **Dark mode.** The toolbar matches Strava's own dark theme. Respects both the OS-level `prefers-color-scheme: dark` and Strava's explicit toggles (`html.dark`, `body.dark`, `[data-theme='dark']`, `[data-color-scheme='dark']`). The brand-orange primary button stays the same in both modes; surface, borders, text, status colours, and the spinner track flip.
- **No-photo handling.** Activities the user selected that have no photos are silently skipped during discovery; if no selected activity has any media at all, the toolbar surfaces "No photos found." (or "No photos or videos found." when Include videos is on).
- **Partial-failure handling.** Bulk runs where some photos succeed and others fail land on a warn-kind `Saved N items, skipped M (reason)` status; the successful items still bundle into a zip.
- **HLS error path.** If the master m3u8 fails to load, the affected video is recorded as a failure, but the photos in the same activity still save. A single bad video URL no longer poisons the whole run.
- **Progress and status.** Inline spinner plus localized status messages - `Preparing N activities…`, `Downloading N / M photos…` (or `… items…` when videos are mixed in), `Building zip…`, terminal success / partial-success / error states.
- **Localization.** 15 locales ship: `en` (source), `de`, `es`, `fr`, `it`, `ja`, `ko`, `nl`, `nb`, `pl`, `pt_BR`, `ru`, `zh_CN`, `zh_TW`, `cs`. Chrome picks the right one based on the user's browser language; missing keys fall back to `en`.
- **Privacy and trust model.** No backend, no analytics, no telemetry, no remote code. The only network destinations are `www.strava.com` (for activity HTML), Strava's photo CDN (`dgtzuqphqg23d.cloudfront.net`), and Strava's video CDN (`d35tn3x5zm6xrc.cloudfront.net`, only when Include videos is on). All fetches are gated on user clicks. See `PRIVACY.md`.
- **End-to-end test suite.** 16 Playwright behaviour tests across two fixtures: list-page toolbar mount, per-row injection, multi-select, route-override sanity, bare-URL probe + fallback, photos-only success, "no photos found", videos-on HLS path, mixed-success failures, HLS master 404 skip, piexifjs EXIF-injection canary, plus six single-activity-page tests covering toolbar mount inside `#activity-photos-container`, bulk button starting enabled, status-on-new-row layout, empty-status collapse, one-click download filename, and dark-mode CSS variable flipping. Plus 11 screenshot specs that regenerate the README crops and the Chrome Web Store carousel images automatically.

### Notes

- Manifest V3. The only declared `host_permissions` are the two Strava CDN hosts above; without these, MV3's CORS behaviour for content scripts would block every photo and video fetch. No `permissions` entries; no broad host access. The content-script `matches` cover `https://www.strava.com/athlete/training*`, `https://www.strava.com/activities/*`, and `https://www.strava.com/athletes/*`.
- The background service worker performs all CDN fetches, EXIF injection, and HLS muxing. Content scripts orchestrate UI and progress.
- Built with TypeScript 6, Vite 8 (Rolldown), and the `@crxjs/vite-plugin`. Runtime deps: `jszip`, `piexifjs`.

[1.0.1]: https://github.com/mladimatija/strava-bulk-photo-export/releases/tag/v1.0.1
[1.0.0]: https://github.com/mladimatija/strava-bulk-photo-export/releases/tag/v1.0.0
