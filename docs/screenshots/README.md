# Screenshots

Drop the README screenshots here as PNG. They're regenerated automatically by `npm run test:screenshots`, which drives the two fixture pages in `tests/fixtures/` with Playwright and writes the cropped captures into this folder.

Files in this folder:

- `toolbar.png` - the toolbar above the activities table, idle (0 selected).
- `per-row.png` - close-up showing the per-row checkbox and the "Photos" button.
- `bulk.png` - mid-bulk-download with the spinner visible ("Downloading N / M photos…").
- `single-toolbar.png` - the toolbar mounted beneath the photo strip on a single activity page, idle.
- `single-toolbar-saved.png` - the same toolbar on a single activity page in the terminal "Saved N photos from 1 activities." state, with the status line dropped onto a new row beneath the controls.

The README references each of these by path. If you rename any of them, update `README.md` to match.
