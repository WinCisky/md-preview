import { expect, type Page } from '@playwright/test';

export type StoreName = 'documents' | 'revisions' | 'attachments';

/** PNG 1x1 trasparente: abbastanza per verificare che l'anteprima lo renderizzi. */
export const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface SeedFile {
	name: string;
	mimeType: string;
	/** Contenuto in base64; per le immagini basta un PNG 1x1. */
	base64: string;
}

export interface SeedDocument {
	id: string;
	title: string;
	updatedAt: number;
}

/**
 * Apre il database della cronologia dal contesto della pagina, replicando lo
 * schema di src/lib/history-db.ts. Va tenuto allineato a quello dell'app:
 * qualunque delle due richieste (test o app) vinca la corsa ad aprire per prima
 * il database gli object store devono venire creati correttamente — e
 * soprattutto con la stessa versione, altrimenti l'apertura con la versione più
 * bassa fallisce con un VersionError.
 *
 * Definita come stringa e valutata nel browser perché serve identica dentro più
 * `page.evaluate`, che non possono catturare funzioni dal contesto Node.
 */
function openHistoryDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('md-preview-history', 2);
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
			if (!db.objectStoreNames.contains('attachments')) {
				db.createObjectStore('attachments', { keyPath: 'id' }).createIndex(
					'documentId',
					'documentId'
				);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Ricostruisce un File a partire dal suo contenuto base64, lato browser. */
function toFile(file: SeedFile): File {
	const binary = atob(file.base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new File([bytes], file.name, { type: file.mimeType });
}

/** Sorgente delle due funzioni qui sopra, iniettata in ogni page.evaluate. */
const BROWSER_HELPERS = `${openHistoryDb};\n${toFile};`;

/**
 * Esegue nel browser una funzione che può usare `openHistoryDb()` e `toFile()`.
 * Playwright serializza il corpo della callback, quindi gli helper vanno
 * spediti come sorgente e reinstallati sul posto.
 */
function evaluateWithHelpers<Arg, Result>(
	page: Page,
	body: (arg: Arg) => Promise<Result> | Result,
	arg: Arg
): Promise<Result> {
	return page.evaluate(
		([source, body, arg]) => {
			const run = new Function(`${source}\nreturn (${body});`)() as (
				arg: Arg
			) => Promise<Result> | Result;
			return run(arg);
		},
		[BROWSER_HELPERS, body.toString(), arg] as const
	);
}

/**
 * Conta i record presenti in uno degli object store della cronologia, leggendo
 * direttamente dal browser. Usato con `expect(...).toPass()` per attendere in
 * modo deterministico che il salvataggio debounced dell'editor
 * (SAVE_DEBOUNCE_MS in markdown-previewer.svelte) sia stato effettivamente
 * scritto, invece di affidarsi a un'attesa fissa.
 */
export function countRecords(page: Page, storeName: StoreName): Promise<number> {
	return evaluateWithHelpers(
		page,
		async (storeName: StoreName) => {
			const db = await openHistoryDb();
			if (!db.objectStoreNames.contains(storeName)) {
				db.close();
				return 0;
			}
			const countRequest = db.transaction(storeName, 'readonly').objectStore(storeName).count();
			const count = await new Promise<number>((resolve, reject) => {
				countRequest.onsuccess = () => resolve(countRequest.result);
				countRequest.onerror = () => reject(countRequest.error);
			});
			db.close();
			return count;
		},
		storeName
	);
}

export async function waitForRecordCount(page: Page, storeName: StoreName, expectedCount: number) {
	await expect(async () => {
		expect(await countRecords(page, storeName)).toBe(expectedCount);
	}).toPass({ timeout: 10000 });
}

/**
 * Apre l'editor e attende che l'isola Svelte sia idratata. L'anteprima è vuota
 * nell'HTML servito (la sanitizzazione avviene solo lato client): finché non
 * compare, gli handler di paste/drop non sono ancora agganciati e un evento
 * sintetico andrebbe perso.
 */
export async function gotoEditor(page: Page) {
	await page.goto('./');
	await expect(page.getByRole('heading', { name: 'Hello Markdown', level: 1 })).toBeVisible();
}

/**
 * Simula un vero evento "paste" del browser sulla textarea dell'editor:
 * legge selectionStart/selectionEnd al momento del dispatch (così l'euristica
 * dell'app in handlePaste può valutarli correttamente) e poi applica il testo
 * incollato al posto della selezione, come farebbe nativamente il browser.
 */
export async function pasteText(page: Page, text: string, options: { selectAll?: boolean } = {}) {
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

/** Incolla dei file nella textarea, come farebbe Ctrl+V su uno screenshot. */
export async function pasteFiles(page: Page, files: SeedFile[]) {
	await evaluateWithHelpers(
		page,
		(files: SeedFile[]) => {
			const el = document.querySelector<HTMLTextAreaElement>('#markdown-input')!;
			el.focus();
			const dataTransfer = new DataTransfer();
			for (const file of files) dataTransfer.items.add(toFile(file));
			el.dispatchEvent(
				new ClipboardEvent('paste', {
					clipboardData: dataTransfer,
					bubbles: true,
					cancelable: true,
				})
			);
		},
		files
	);
}

/** Invia una sequenza di eventi di drag con dei file sulla drop zone dell'editor. */
export async function dragFiles(page: Page, files: SeedFile[], types: string[]) {
	await evaluateWithHelpers(
		page,
		({ files, types }: { files: SeedFile[]; types: string[] }) => {
			const el = document.querySelector<HTMLElement>('[data-testid="editor-drop-zone"]')!;
			const dataTransfer = new DataTransfer();
			for (const file of files) dataTransfer.items.add(toFile(file));
			for (const type of types) {
				el.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
			}
		},
		{ files, types }
	);
}

/** Rilascia dei file sulla drop zone dell'editor. */
export async function dropFiles(page: Page, files: SeedFile[]) {
	await dragFiles(page, files, ['dragenter', 'dragover', 'drop']);
}

/** Scrive direttamente dei documenti in IndexedDB, per testare i raggruppamenti per data. */
export async function seedDocuments(page: Page, documents: SeedDocument[]) {
	await evaluateWithHelpers(
		page,
		async (documents: SeedDocument[]) => {
			const db = await openHistoryDb();
			const tx = db.transaction('documents', 'readwrite');
			const store = tx.objectStore('documents');
			for (const seed of documents) {
				store.put({
					id: seed.id,
					title: seed.title,
					origin: 'typed',
					createdAt: seed.updatedAt,
					updatedAt: seed.updatedAt,
					latestContent: `# ${seed.title}`,
				});
			}
			await new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		documents
	);
}
