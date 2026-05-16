# Contributing

Thanks for your interest in improving Strava Bulk Photo Export! This is a small project - feature ideas, bug reports, and code contributions are all welcome.

## Getting the dev environment running

Requirements:

- Node.js **>= 24** (matches the Vite 8 / Rolldown toolchain we build against in CI).
- A Chromium-based browser (Chrome / Brave / Edge / Arc) for loading the unpacked extension.

```bash
git clone https://github.com/mladimatija/strava-bulk-photo-export.git
cd strava-bulk-photo-export
npm install
npm run build
```

Load the unpacked extension:

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked**, pick the `dist/` folder.

Iterate with `npm run dev` for HMR, or `npm run build` then click the reload icon next to the extension in `chrome://extensions`.

## What `npm run check` does

`check` is the umbrella command that gates PRs. It runs:

- `npm run lint` - ESLint flat config, type-aware rules for `src/**/*.ts`.
- `npm run format:check` - Prettier verification (use `npm run format` to fix).
- `npm run type-check` - `tsc --noEmit` against the project tsconfig.

CI runs the same three as separate jobs plus a build job and an E2E job. Run `npm run check` locally before pushing to avoid the CI ping-pong.

## Running the tests

The Playwright suite is split into two projects: `e2e` (behaviour assertions) and `screenshots` (image regeneration). Both projects load the built extension into a real Chromium instance and intercept Strava URLs to serve a fixture from `tests/fixtures/`.

```bash
npm run test:install     # one-time: install Playwright's bundled Chromium + system deps
npm run build            # tests run against dist/, so always build first
npm test                 # E2E behaviour assertions (tests/e2e/extension.spec.ts)
npm run test:screenshots # regenerate docs/screenshots/* and docs/store/screenshot-*.png
```

There are two fixtures: `tests/fixtures/strava-training.html` (a stripped-down activities table with five rows) and `tests/fixtures/strava-activity.html` (a fuller replica of `/activities/<id>` with sidenav, heading, photo strip, weather block, and stats column). Tests opt into the activity fixture via `test.use({ fixtureKind: 'activity' })`; the default is `'training'`.

### Headful Chromium and xvfb-run

The fixture launches Chromium with `headless: false` because Chrome only loads extensions in headful mode - the old headless mode silently ignores `--load-extension`, and Chrome 137+ additionally requires `--disable-features=DisableLoadExtensionCommandLineSwitch` to permit the flag at all. On macOS and Windows that just means a visible browser window pops up while the suite runs. On Linux (including CI runners and headless dev VMs) you need a virtual display, so prefix the command with `xvfb-run`:

```bash
xvfb-run --auto-servernum npm test
xvfb-run --auto-servernum npm run test:screenshots
```

The `release.yml` workflow does this for you automatically; local Linux contributors need to do it manually.

### Running against your installed Chrome stable

By default the tests use Playwright's bundled Chromium - pinned to whatever Playwright version is installed, which keeps the suite reproducible across machines. To run against your installed Chrome stable instead (closer to what end users have but less reproducible), set `PWTEST_BROWSER=chrome`:

```bash
PWTEST_BROWSER=chrome npm test
```

Same flag set, different binary.

## Pre-commit hooks

`simple-git-hooks` + `lint-staged` are installed; they're activated by `npm install` (via the `postinstall` step). On commit, only staged files are linted/formatted.

If you skip a hook with `--no-verify`, expect CI to catch the same issues.

## Code style

TypeScript everywhere in `src/`. Build scripts in `scripts/` are Node ESM JS. Strict ESLint and Prettier configs are the source of truth; don't manually nudge formatting. Functions get JSDoc comments when their behaviour isn't obvious from the name. Inline TypeScript-style block comments above non-trivial chunks of code, explaining the "why" rather than the "what", are part of the project style; you'll see them throughout `src/content.ts` and `src/background.ts`.

## Filing issues

Use the bug report or feature request template (you'll be prompted on https://github.com/mladimatija/strava-bulk-photo-export/issues/new/choose). The templates exist to save us back-and-forth - please fill out the version + repro steps, otherwise the issue may sit until I can guess at the missing context.

**Security issues should NOT use the public issue tracker** - please follow the disclosure process in [`SECURITY.md`](SECURITY.md).

## Pull request flow

1. Fork → create a branch → push.
2. Open the PR with the PR template filled in.
3. CI runs `check` + `build` + the E2E and screenshot suites. Green is required for merge.
4. Reviews are usually within a few days; I do this on the side.
5. Squash-merge on landing. Keep your branch's commit history clean if you can - it ends up in the squash message.

If your PR changes user-visible UI, regenerate the screenshots (`npm run test:screenshots`) and commit the updated PNGs along with the code change. CI doesn't auto-commit screenshots; stale images on `main` are easy to spot but annoying to chase.

## Releases

Releases are tagged `vMAJOR.MINOR.PATCH`. Pushing a tag triggers `release.yml`, which builds, runs `check` + the full Playwright suite, packages `dist/` as `strava-bulk-photo-export.zip`, and attaches it to a GitHub Release with auto-generated release notes.

`package.json.version` is the source of truth - `manifest.json.version` is overwritten at build time by `vite.config.ts` (a small `toChromeVersion()` helper strips SemVer prerelease suffixes so Chrome's manifest format stays happy), so don't edit it directly.

To cut a release locally:

```bash
npm version patch    # or minor / major; bumps package.json
git push --follow-tags
```

When you bump the version, also add (or extend) the matching dated entry in `CHANGELOG.md`. The convention in this repo is one entry per published version - the pre-release changes that build up between tags live in your PR descriptions and the squashed commit history, and roll up into a single `[X.Y.Z]` block when the tag goes out.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
