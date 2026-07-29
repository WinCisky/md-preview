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
	treeContextMenu,
	waitForNodeContent,
	waitForRecordCount,
} from './helpers';

const PNG = { name: 'pic.png', mimeType: 'image/png', base64: PNG_1X1_BASE64 };
// "%PDF-1.4" in base64: the content does not matter, what matters is that the MIME is not image/*.
const PDF = { name: 'spec.pdf', mimeType: 'application/pdf', base64: 'JVBERi0xLjQK' };

test.describe('Attachments', () => {
	test('pasting an image attaches it and renders it in the preview', async ({
		page,
		browserName,
	}) => {
		// Gecko builds the ClipboardEvent but empties its DataTransfer (files: 0,
		// types: []), so a synthetic paste carrying files can only be checked on
		// Chromium. The rest of the path is covered by the drag & drop tests.
		test.skip(browserName !== 'chromium', 'synthetic ClipboardEvent carries no files outside Chromium');

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

		// The attachment reference has been saved into the open file.
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);
	});

	test('shows a drop overlay only while files are being dragged over the editor', async ({
		page,
	}) => {
		await gotoEditor(page);
		const overlay = page.getByTestId('drop-overlay');
		await expect(overlay).toBeHidden();

		await dragFiles(page, [PNG], ['dragenter', 'dragover']);
		await expect(overlay).toBeVisible();

		// Entering a child and leaving it must not make the overlay disappear: the
		// depth counter is what keeps it on while the drag is still over.
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
		await waitForRecordCount(page, 'attachments', 1);
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);

		await page.goto('./');

		// The file is reopened and the blob read back from IndexedDB.
		await expect(page.locator('#markdown-input')).toHaveValue(/attachment:[0-9a-f-]+/);
		await expect(page.locator('#preview-pane img')).toHaveAttribute('src', /^blob:/);
	});

	// Tree nodes have no extension: it is the export that adds ".md" to the name
	// of the open file.
	test('exports a plain .md named after the open file', async ({ page }) => {
		await gotoEditor(page);

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download Markdown' }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe('welcome.md');
	});

	test('exports a zip with the attachments folder when the document has attachments', async ({
		page,
	}) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG, PDF]);
		await waitForRecordCount(page, 'attachments', 2);
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);

		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download Markdown' }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toBe('welcome.zip');

		const zipPath = await download.path();
		const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
		expect(Object.keys(entries).sort()).toEqual([
			'attachments/pic.png',
			'attachments/spec.pdf',
			'welcome.md',
		]);

		// The "attachment:<id>" references have been rewritten into relative paths.
		const markdown = strFromU8(entries['welcome.md']);
		expect(markdown).toContain('![pic.png](attachments/pic.png)');
		expect(markdown).toContain('[spec.pdf](attachments/spec.pdf)');
		expect(markdown).not.toContain('attachment:');
	});

	test('deletes an attachment once the text no longer references it', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG]);
		await waitForRecordCount(page, 'attachments', 1);
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);

		// With the reference removed the blob is no longer reachable: it has to be deleted.
		await page.locator('#markdown-input').fill('# No attachments');
		await waitForRecordCount(page, 'attachments', 0);
		await expect(page.locator('#preview-pane img')).toHaveCount(0);
	});

	test('deletes the attachments of a file removed from the tree', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG, PDF]);
		await waitForRecordCount(page, 'attachments', 2);
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);

		await treeContextMenu(page, 'welcome', 'Delete');

		await expect(page.getByTestId('tree-file')).toHaveCount(0);
		await waitForRecordCount(page, 'attachments', 0);
	});

	test('keeps the attachments of a file that is not the one being edited', async ({ page }) => {
		await gotoEditor(page);
		await dropFiles(page, [PNG]);
		await waitForRecordCount(page, 'attachments', 1);
		await waitForNodeContent(page, 'welcome', /attachment:[0-9a-f-]+/);

		// Opening another file replaces the editor text entirely: the unused
		// attachment collection must not mistake that for a removal of the
		// previous file's references.
		await page.getByTestId('tree-root').click();
		await page.getByRole('button', { name: 'New file' }).click();
		await page.getByTestId('tree-rename-input').press('Enter');
		await page.locator('#markdown-input').fill('# Another file');
		await waitForNodeContent(page, 'untitled', /# Another file/);

		expect(await countRecords(page, 'attachments')).toBe(1);
	});
});
