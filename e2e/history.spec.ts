import { expect, test, type Page } from '@playwright/test';

/**
 * Conta i record presenti in uno degli object store IndexedDB della
 * cronologia, leggendo direttamente dal browser. Usato con `expect(...).toPass()`
 * per attendere in modo deterministico che il salvataggio debounced
 * dell'editor (SAVE_DEBOUNCE_MS in markdown-previewer.svelte) sia stato
 * effettivamente scritto, invece di affidarsi a un'attesa fissa.
 */
function countRecords(page: Page, storeName: 'documents' | 'revisions'): Promise<number> {
	return page.evaluate((storeName) => {
		return new Promise<number>((resolve, reject) => {
			// Stessa versione/schema di src/lib/history-db.ts: dichiariamo qui lo
			// stesso onupgradeneeded così che, qualunque delle due richieste (test
			// o app) vinca la corsa ad aprire per prima il database, gli object
			// store vengano comunque creati correttamente.
			const request = indexedDB.open('md-preview-history', 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains('documents')) {
					db.createObjectStore('documents', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
				}
				if (!db.objectStoreNames.contains('revisions')) {
					db.createObjectStore('revisions', { keyPath: 'id', autoIncrement: true }).createIndex(
						'documentId',
						'documentId'
					);
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(storeName)) {
					db.close();
					resolve(0);
					return;
				}
				const tx = db.transaction(storeName, 'readonly');
				const countRequest = tx.objectStore(storeName).count();
				countRequest.onsuccess = () => {
					resolve(countRequest.result);
					db.close();
				};
				countRequest.onerror = () => {
					reject(countRequest.error);
					db.close();
				};
			};
			request.onerror = () => reject(request.error);
		});
	}, storeName);
}

async function waitForRecordCount(
	page: Page,
	storeName: 'documents' | 'revisions',
	expectedCount: number
) {
	await expect(async () => {
		expect(await countRecords(page, storeName)).toBe(expectedCount);
	}).toPass({ timeout: 10000 });
}

/**
 * Simula un vero evento "paste" del browser sulla textarea dell'editor:
 * legge selectionStart/selectionEnd al momento del dispatch (così l'euristica
 * dell'app in handlePaste può valutarli correttamente) e poi applica il testo
 * incollato al posto della selezione, come farebbe nativamente il browser.
 */
async function pasteText(page: Page, text: string, options: { selectAll?: boolean } = {}) {
	const { selectAll = false } = options;
	await page.locator('#markdown-input').evaluate(
		(el: HTMLTextAreaElement, { text, selectAll }) => {
			el.focus();
			if (selectAll) {
				el.setSelectionRange(0, el.value.length);
			}
			const dataTransfer = new DataTransfer();
			dataTransfer.setData('text/plain', text);
			const pasteEvent = new ClipboardEvent('paste', {
				clipboardData: dataTransfer,
				bubbles: true,
				cancelable: true,
			});
			el.dispatchEvent(pasteEvent);

			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? el.value.length;
			el.value = el.value.slice(0, start) + text + el.value.slice(end);
			el.dispatchEvent(new Event('input', { bubbles: true }));
		},
		{ text, selectAll }
	);
}

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
