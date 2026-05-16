<!--
Thanks for the PR! Please fill out as much of the below as applies.
-->

## What does this change?

<!-- One- or two-sentence summary. Link the issue this closes if any. -->

Closes #

## How to test

<!-- Steps a reviewer can follow to verify the change in their own browser. -->

1. `npm install && npm run build`
2. Load the unpacked `dist/` in chrome://extensions
3. Visit https://www.strava.com/athlete/training
4. …

## Screenshots / GIFs (if the UI changed)

<!-- Before/after pair is ideal. Drag images into this textarea. -->

## Checklist

- [ ] `npm run check` passes (lint + format + type-check)
- [ ] `npm test` passes (or noted in the PR description why it's skipped)
- [ ] I tested in Chrome (and Brave/Edge if applicable)
- [ ] Updated `CHANGELOG.md` with a note describing the change
- [ ] If user-facing copy or layout changed: regenerated screenshots with `npm run test:screenshots`
- [ ] If new dependency added: noted why in the PR description
