import { expect, test } from '@playwright/test';
import { pasteText, waitForRecordCount } from './helpers';

test.describe('History', () => {
	test('groups consecutive typed edits under a single document', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Doc One\n\nFirst version.');
		await waitForRecordCount(page, 'documents', 1);

		await input.fill('# Doc One\n\nSecond version.');
		await waitForRecordCount(page, 'revisions', 2);
		await waitForRecordCount(page, 'documents', 1);

		await page.goto('./history');

		const documents = page.getByTestId('history-document');
		await expect(documents).toHaveCount(1);
		await expect(documents.first().getByTestId('history-document-meta')).toContainText('Digitato');

		await documents.first().click();
		const revisions = page.getByTestId('history-revision');
		await expect(revisions).toHaveCount(2);
	});

	test('creates a distinct document when pasting a full replacement', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Doc One\n\nOriginal content.');
		await waitForRecordCount(page, 'documents', 1);

		await pasteText(page, '# Doc Two\n\nCompletely different document.', { selectAll: true });
		await waitForRecordCount(page, 'documents', 2);

		await page.goto('./history');

		const documents = page.getByTestId('history-document');
		await expect(documents).toHaveCount(2);
		const titles = await documents.getByTestId('history-document-title').allTextContents();
		expect(titles).toContain('Doc One');
		expect(titles).toContain('Doc Two');

		const pastedDoc = documents.filter({ hasText: 'Doc Two' });
		await expect(pastedDoc.getByTestId('history-document-meta')).toContainText('Incollato');
	});

	test('restores a document into the editor', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Restorable Doc\n\nContent to restore.');
		await waitForRecordCount(page, 'documents', 1);

		await page.goto('./history');
		const document = page.getByTestId('history-document').filter({ hasText: 'Restorable Doc' });
		await document.getByRole('button', { name: "Apri nell'editor" }).click();

		await expect(page.locator('#markdown-input')).toHaveValue('# Restorable Doc\n\nContent to restore.');
		await expect(page.getByRole('heading', { name: 'Restorable Doc', level: 1 })).toBeVisible();
	});

	test('reopens the most recently saved document on page load', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Older Doc\n\nSaved first.');
		await waitForRecordCount(page, 'documents', 1);

		await pasteText(page, '# Newer Doc\n\nSaved last.', { selectAll: true });
		await waitForRecordCount(page, 'documents', 2);

		await page.goto('./');

		// Al posto del testo di default viene ripreso l'ultimo documento salvato.
		await expect(page.locator('#markdown-input')).toHaveValue('# Newer Doc\n\nSaved last.');
		await expect(page.getByRole('heading', { name: 'Newer Doc', level: 1 })).toBeVisible();
		await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

		// Le modifiche successive continuano quel documento invece di crearne uno nuovo.
		await page.locator('#markdown-input').fill('# Newer Doc\n\nEdited after reload.');
		await waitForRecordCount(page, 'documents', 2);

		await page.goto('./history');
		const documents = page.getByTestId('history-document');
		await expect(documents).toHaveCount(2);
		await documents.filter({ hasText: 'Newer Doc' }).click();
		await expect(page.getByTestId('history-revision')).toHaveCount(2);
	});

	test('reflects the save lifecycle in the history button indicator', async ({ page }) => {
		await page.goto('./');

		const indicator = page.getByTestId('save-status');
		// Nulla in attesa di salvataggio all'avvio.
		await expect(indicator).toHaveAttribute('data-status', 'saved');

		const input = page.locator('#markdown-input');
		await input.fill('# Indicator Doc\n\nUnsaved for now.');
		// Il debounce (1500 ms) lascia un margine ampio per osservare lo stato "sporco".
		await expect(indicator).toHaveAttribute('data-status', 'pending');

		await waitForRecordCount(page, 'documents', 1);
		await expect(indicator).toHaveAttribute('data-status', 'saved');
	});

	test('deletes a single document and clears the whole history', async ({ page }) => {
		await page.goto('./');

		const input = page.locator('#markdown-input');
		await input.fill('# Doc To Delete\n\nSome content.');
		await waitForRecordCount(page, 'documents', 1);

		await pasteText(page, '# Doc To Keep\n\nAnother document.', { selectAll: true });
		await waitForRecordCount(page, 'documents', 2);

		await page.goto('./history');
		await expect(page.getByTestId('history-document')).toHaveCount(2);

		page.once('dialog', (dialog) => dialog.accept());
		const docToDelete = page.getByTestId('history-document').filter({ hasText: 'Doc To Delete' });
		await docToDelete.getByRole('button', { name: 'Elimina documento' }).click();

		await expect(page.getByTestId('history-document')).toHaveCount(1);

		page.once('dialog', (dialog) => dialog.accept());
		await page.getByRole('button', { name: 'Svuota tutta la cronologia' }).click();

		await expect(page.getByText('Nessun documento in cronologia')).toBeVisible();
	});
});
