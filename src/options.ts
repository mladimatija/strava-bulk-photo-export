// Options page logic. Loads the configured filename template from
// chrome.storage.sync, renders it into the input, and gives the user a
// live preview against a fixed sample context. Save persists; Reset
// drops the value back to the default pattern so the user can recover
// from an unparseable typo without remembering what the default was.

import {
	DEFAULT_FILENAME_TEMPLATE,
	renderFilenameTemplate,
	type FilenameTemplateContext,
} from './filename-template.ts';
import { loadFilenameTemplate, saveFilenameTemplate } from './storage.ts';
import { t, type MessageKey } from './i18n.ts';

// Sample data shown in the preview. Pick values that exercise every
// supported placeholder so the user can eyeball the effect of every
// change without running an actual export.
const PREVIEW_CTX: FilenameTemplateContext = {
	activityId: '18437723885',
	activityName: 'Morning Run',
	sport: 'Run',
	date: '2024-05-14',
	dateLong: '2024-05-14-10-30-00',
	kind: 'photo',
	index: 1,
	ext: 'jpg',
};

/** Replace every `data-i18n="key"` element's text content with its localized string. */
function applyI18nToDom(): void {
	for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
		const key = el.dataset.i18n as MessageKey | undefined;
		if (key) el.textContent = t(key);
	}
	// Title also gets the localized string so the browser tab reads correctly.
	document.title = t('optionsTitle');
}

function $<T extends Element>(selector: string): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`Missing element: ${selector}`);
	return el;
}

function renderPreview(template: string, output: HTMLElement): void {
	const value = template.trim() === '' ? DEFAULT_FILENAME_TEMPLATE : template;
	output.textContent = renderFilenameTemplate(value, PREVIEW_CTX);
}

async function init(): Promise<void> {
	applyI18nToDom();

	const input = $<HTMLInputElement>('[data-role="template-input"]');
	const preview = $<HTMLElement>('[data-role="template-preview"]');
	const form = $<HTMLFormElement>('.sbpx-options-form');
	const resetBtn = $<HTMLButtonElement>('[data-role="reset"]');
	const savedConfirmation = $<HTMLElement>('[data-role="saved-confirmation"]');

	input.placeholder = DEFAULT_FILENAME_TEMPLATE;
	const current = await loadFilenameTemplate();
	input.value = current;
	renderPreview(current, preview);

	input.addEventListener('input', () => {
		renderPreview(input.value, preview);
		savedConfirmation.hidden = true;
	});

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		await saveFilenameTemplate(input.value);
		savedConfirmation.textContent = t('optionsSavedConfirmation');
		savedConfirmation.hidden = false;
	});

	resetBtn.addEventListener('click', async () => {
		input.value = DEFAULT_FILENAME_TEMPLATE;
		renderPreview(input.value, preview);
		await saveFilenameTemplate(DEFAULT_FILENAME_TEMPLATE);
		savedConfirmation.textContent = t('optionsSavedConfirmation');
		savedConfirmation.hidden = false;
	});
}

void init();
