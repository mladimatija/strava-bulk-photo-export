# Privacy Policy

**Effective date:** 2026-05-14

This extension is designed so that it cannot, by construction, collect or transmit your data to anyone except Strava itself. Read this page to understand exactly how that works.

## What the extension can access

When you visit a Strava page that matches one of the content-script patterns (`https://www.strava.com/athlete/training*`, `https://www.strava.com/activities/*`, `https://www.strava.com/athletes/*`), the extension is allowed to:

- Read and modify the DOM of that page (to add download buttons and a toolbar).
- Make requests to other URLs on `strava.com` and Strava's photo CDN **using your existing logged-in browser session**. The URLs the extension fetches are the same image URLs the page itself already references for display.
- Save files to your computer via the browser's download mechanism (so the zip of photos lands in your Downloads folder).

That's the entire permission surface. The extension does not request access to your cookies as a permission, your browsing history, your other tabs, or any non-Strava domain.

## What we collect, store, or transmit

**Nothing.** This extension has no backend, no analytics, no telemetry, no error reporting service, no remote configuration. Every line of code runs locally in your browser. The only network requests it makes are to `www.strava.com` and Strava's image CDN, and they only happen when you click a download button.

Your Strava session cookie, your activity data, your photos, your selections - none of it leaves your machine. We never see it because there is no "we" on the server side.

## Where your data goes

When you click **Photos** on a row or **Download photos** in the toolbar:

1. The extension reads the photo URLs that Strava's own page already lists for each selected activity.
2. It fetches each photo directly from Strava's image CDN (using the URLs Strava itself emitted).
3. The browser writes the resulting zip to your Downloads folder.

Strava is the only third party. Their privacy policy applies to those requests: <https://www.strava.com/legal/privacy>.

## What the extension does _not_ do

- Does not request the `cookies` permission. It cannot read your session cookie value - it relies on the browser's same-origin handling to attach cookies automatically to requests it makes to `strava.com`.
- The only `host_permissions` it declares are for Strava's photo CDN (`https://dgtzuqphqg23d.cloudfront.net/*`) and Strava's video CDN (`https://d35tn3x5zm6xrc.cloudfront.net/*`, used only when the "Include videos" toolbar checkbox is on). These grant the extension the ability to fetch your photos and (optionally) videos from those hosts via the background service worker, since Manifest V3 content scripts can't bypass CORS without them. The extension does not request access to any other origin.
- Does not include any analytics or tracking SDKs.
- Does not contain any remote-loaded code. Every byte the extension runs is shipped in the version you install.
- Does not phone home for updates or version checks - Chrome handles updates through the Web Store.

## Open source and verifiable builds

The source code is published at <https://github.com/mladimatija/strava-bulk-photo-export>. The build is deterministic - if you run `npm install && npm run build` from a clean clone at the tagged commit, you should get a byte-identical `dist/` directory to what's in the Chrome Web Store listing. If you find a discrepancy, please file an issue.

## Affiliation disclaimer

This extension is not developed, endorsed by, or affiliated with Strava, Inc. "Strava" is a trademark of Strava, Inc.

## Contact

For privacy questions, bugs, and feature requests: <https://github.com/mladimatija/strava-bulk-photo-export/issues>
