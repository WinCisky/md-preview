import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import {
	PNG_1X1_BASE64,
	countRecords,
	dragFiles,
	dropFiles,
	gotoEditor,
	pasteFiles,
	waitForRecordCount,
} from './helpers';

const PNG = { name: 'pic.png', mimeType: 'image/png', base64: PNG_1X1_BASE64 };
// "%PDF-1.4" in base64: il contenuto non conta, conta che il MIME non sia image/*.
const PDF = { name: 'spec.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' };

test.describe('Attachments', () => {
	test('pasting an image attaches it and renders it in the preview', async ({
		page,
		browserName,
	}) => {
		// Gecko costruisce ClipboardEvent ma ne svuota il DataTransfer (files: 0,
		// types: []), quindi un incolla sintetico con file è verificabile solo su
		// Chromium. Il resto del percorso è coperto dai test con drag & drop.
		test.skip(browserName !== 'chromium', 'ClipboardEvent sintetico senza file fuori da Chromium');

		await gotoEditor(page);
		await pasteFiles(page, [PNG]);

		await expect(page.locator('#markdown-input')).toHaveValue(
			/!\[pic\.png\]\(attachment:[0-9a-f-]+\)/
		);
		await waitForRecordCount(page, 'attachments', 1);

		const image = page.locator('#preview-pane img');
		await expect(image).toHaveAttribute('src', /^blob:/);
		await expect(image).toHaveAttribute('alt', 'pic.png');
	});

	test('dropping an image attaches it and renders it in the preview', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG]);

		await expect(page.locator('#markdown-input')).toHaveValue(
			/!\[pic\.png\]\(attachment:[0-9a-f-]+\)/
		);
		await waitForRecordCount(page, 'attachments', 1);

		const image = page.locator('#preview-pane img');
		await expect(image).toHaveAttribute('src', /^blob:/);
		await expect(image).toHaveAttribute('alt', 'pic.png');

		// L'allegato è stato inserito prima che esistesse un documento: il testo
		// modificato ne fa nascere uno e l'allegato deve essere stato adottato.
		await waitForRecordCount(page, 'documents', 1);
	});

	test('shows a drop overlay only while files are being dragged over the editor', async ({
		page,
	}) => {
		await gotoEditor(page);
		const overlay = page.getByTestId('drop-overlay');
		await expect(overlay).toBeHidden();

		await dragFiles(page, [PNG], ['dragenter', 'dragover']);
		await expect(overlay).toBeVisible();

		// Entrare in un figlio e uscirne non deve far sparire l'overlay: è il
		// contatore di profondità a tenerlo acceso finché il drag è ancora sopra.
		await dragFiles(page, [PNG], ['dragenter', 'dragleave']);
		await expect(overlay).toBeVisible();

		await dragFiles(page, [PNG], ['dragleave']);
		await expect(overlay).toBeHidden();
	});

	test('dropping a non-image file attaches it as a download link', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PDF]);

		await expect(page.locator('#markdown-input')).toHaveValue(
			/\[spec\.pdf\]\(attachment:[0-9a-f-]+\)/
		);
		await waitForRecordCount(page, 'attachments', 1);

		const link = page.locator('#preview-pane a', { hasText: 'spec.pdf' });
		await expect(link).toHaveAttribute('href', /^blob:/);
		await expect(link).toHaveAttribute('download', 'spec.pdf');
		await expect(page.locator('#preview-pane img')).toHaveCount(0);
	});

	test('re-renders attachments after a reload', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG]);
		await waitForRecordCount(page, 'documents', 1);
		await waitForRecordCount(page, 'attachments', 1);

		await page.goto('./');

		// Il documento viene ripreso dalla cronologia e il blob riletto da IndexedDB.
		await expect(page.locator('#markdown-input')).toHaveValue(/attachment:[0-9a-f-]+/);
		await expect(page.locator('#preview-pane img')).toHaveAttribute('src', /^blob:/);
	});

	test('exports a plain .md when the document has no attachments', async ({ page }) => {
		await gotoEditor(page);

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download Markdown' }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe('document.md');
	});

	test('exports a zip with the attachments folder when the document has attachments', async ({
		page,
	}) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG, PDF]);
		await waitForRecordCount(page, 'documents', 1);
		await waitForRecordCount(page, 'attachments', 2);

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download Markdown' }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe('document.zip');

		const zipPath = await download.path();
		const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
		expect(Object.keys(entries).sort()).toEqual([
			'attachments/pic.png',
			'attachments/spec.pdf',
			'document.md',
		]);

		// I riferimenti "attachment:<id>" sono stati riscritti in percorsi relativi.
		const markdown = strFromU8(entries['document.md']);
		expect(markdown).toContain('![pic.png](attachments/pic.png)');
		expect(markdown).toContain('[spec.pdf](attachments/spec.pdf)');
		expect(markdown).not.toContain('attachment:');
	});

	test('lists attachments in the history dropdown and deletes them with the document', async ({
		page,
	}) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG, PDF]);
		await waitForRecordCount(page, 'documents', 1);
		await waitForRecordCount(page, 'attachments', 2);

		await page.goto('./history');

		const document = page.getByTestId('history-document');
		await expect(document).toHaveCount(1);
		await expect(document.getByTestId('history-attachment-count')).toHaveText('2');

		await document.getByTestId('history-document-title').click();
		const attachments = page.getByTestId('history-attachment');
		await expect(attachments).toHaveCount(2);
		await expect(attachments.first()).toContainText('pic.png');
		await expect(attachments.nth(1)).toContainText('spec.pdf');
		// Le revisioni restano visibili nello stesso pannello.
		await expect(page.getByTestId('history-revision')).not.toHaveCount(0);

		page.once('dialog', (dialog) => dialog.accept());
		await document.getByRole('button', { name: 'Elimina documento' }).click();

		await expect(page.getByText('Nessun documento in cronologia')).toBeVisible();
		expect(await countRecords(page, 'attachments')).toBe(0);
	});
});
