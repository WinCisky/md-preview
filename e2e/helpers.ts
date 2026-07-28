import { expect, type Page } from '@playwright/test';

export type StoreName = 'nodes' | 'attachments';

/** PNG 1x1 trasparente: abbastanza per verificare che l'anteprima lo renderizzi. */
export const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface SeedFile {
	name: string;
	mimeType: string;
	/** Contenuto in base64; per le immagini basta un PNG 1x1. */
	base64: string;
}

export interface NodeRecord {
	id: string;
	type: 'file' | 'folder';
	parentId: string;
	name: string;
	content: string;
	expanded?: boolean;
}

/**
 * Apre il database dei file dal contesto della pagina, replicando lo schema di
 * src/lib/files-db.ts. Va tenuto allineato a quello dell'app: qualunque delle
 * due richieste (test o app) vinca la corsa ad aprire per prima il database gli
 * object store devono venire creati correttamente — e soprattutto con la stessa
 * versione, altrimenti l'apertura con la versione più bassa fallisce con un
 * VersionError.
 *
 * Definita come stringa e valutata nel browser perché serve identica dentro più
 * `page.evaluate`, che non possono catturare funzioni dal contesto Node.
 */
function openFilesDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('md-preview-files', 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('nodes')) {
				const nodes = db.createObjectStore('nodes', { keyPath: 'id' });
				nodes.createIndex('parentId', 'parentId');
				nodes.createIndex('updatedAt', 'updatedAt');
			}
			if (!db.objectStoreNames.contains('attachments')) {
				db.createObjectStore('attachments', { keyPath: 'id' }).createIndex('nodeId', 'nodeId');
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
const BROWSER_HELPERS = `${openFilesDb};\n${toFile};`;

/**
 * Esegue nel browser una funzione che può usare `openFilesDb()` e `toFile()`.
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
 * Conta i record presenti in uno degli object store, leggendo direttamente dal
 * browser. Usato con `expect(...).toPass()` per attendere in modo
 * deterministico che il salvataggio debounced dell'editor (SAVE_DEBOUNCE_MS in
 * markdown-previewer.svelte) sia stato effettivamente scritto, invece di
 * affidarsi a un'attesa fissa.
 */
export function countRecords(page: Page, storeName: StoreName): Promise<number> {
	return evaluateWithHelpers(
		page,
		async (storeName: StoreName) => {
			const db = await openFilesDb();
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

/** Tutti i nodi dell'albero come sono scritti su IndexedDB. */
export function readNodes(page: Page): Promise<NodeRecord[]> {
	return evaluateWithHelpers(
		page,
		async () => {
			const db = await openFilesDb();
			const request = db.transaction('nodes', 'readonly').objectStore('nodes').getAll();
			const all = await new Promise<NodeRecord[]>((resolve, reject) => {
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			db.close();
			return all;
		},
		null
	);
}

/** Attende che il file indicato sia stato salvato con un contenuto atteso. */
export async function waitForNodeContent(page: Page, name: string, expected: RegExp) {
	await expect(async () => {
		const nodes = await readNodes(page);
		const node = nodes.find((candidate) => candidate.name === name);
		expect(node?.content ?? '').toMatch(expected);
	}).toPass({ timeout: 10000 });
}

/**
 * Apre l'editor e attende che l'isola Svelte sia idratata. Alla prima apertura
 * l'app crea il file di esempio, il cui contenuto è quello atteso qui.
 */
export async function gotoEditor(page: Page) {
	await page.goto('./');
	await waitForHydration(page);
	await expect(page.getByTestId('tree-file')).toHaveCount(1);
}

/**
 * Attende la prima schermata utile: l'anteprima è vuota nell'HTML servito (la
 * sanitizzazione avviene solo lato client), quindi finché il titolo non compare
 * gli handler di paste/drop non sono ancora agganciati e un evento sintetico
 * andrebbe perso.
 */
export async function waitForHydration(page: Page) {
	await expect(page.getByRole('heading', { name: 'Hello Markdown', level: 1 })).toBeVisible();
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

/**
 * Trascina una riga dell'albero su un'altra (o sull'area radice con
 * `targetName` null). Gli eventi sono sintetici: il drag & drop nativo non è
 * pilotabile in modo affidabile da Playwright. Ritorna true se il dragover è
 * stato accettato, cioè se l'app considera lo spostamento legale.
 */
export function dragTreeNode(
	page: Page,
	sourceName: string,
	targetName: string | null
): Promise<boolean> {
	return page.evaluate(
		({ sourceName, targetName }) => {
			const source = document.querySelector<HTMLElement>(`[data-name="${sourceName}"]`)!;
			const target = targetName
				? document.querySelector<HTMLElement>(`[data-name="${targetName}"]`)!
				: document.querySelector<HTMLElement>('[data-testid="tree-root"]')!;
			const dataTransfer = new DataTransfer();
			const fire = (el: HTMLElement, type: string) => {
				const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
				el.dispatchEvent(event);
				return event.defaultPrevented;
			};
			fire(source, 'dragstart');
			const accepted = fire(target, 'dragover');
			fire(target, 'drop');
			fire(source, 'dragend');
			return accepted;
		},
		{ sourceName, targetName }
	);
}

/**
 * Trascina una riga sopra un'altra e ci resta: niente drop, niente dragend, così
 * l'evidenziazione della destinazione rimane a schermo e può essere verificata.
 */
export async function hoverTreeNode(page: Page, sourceName: string, targetName: string) {
	await page.evaluate(
		({ sourceName, targetName }) => {
			const source = document.querySelector<HTMLElement>(`[data-name="${sourceName}"]`)!;
			const target = document.querySelector<HTMLElement>(`[data-name="${targetName}"]`)!;
			const dataTransfer = new DataTransfer();
			for (const [el, type] of [
				[source, 'dragstart'],
				[target, 'dragover'],
			] as const) {
				el.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
			}
		},
		{ sourceName, targetName }
	);
}

/** Apre il menu contestuale su una riga dell'albero e sceglie una voce. */
export async function treeContextMenu(page: Page, nodeName: string | null, item: string) {
	const target = nodeName
		? page.locator(`[data-name="${nodeName}"]`)
		: page.getByTestId('tree-root');
	await target.click({ button: 'right' });
	await page.getByRole('menuitem', { name: item }).click();
}

/**
 * Conferma il nome del nodo appena creato (che nasce già in rinomina) e attende
 * che la riga rinominata compaia: la scrittura su IndexedDB e il conseguente
 * ricaricamento dell'albero sono asincroni, quindi subito dopo Enter la riga
 * porta ancora il nome provvisorio.
 */
export async function confirmTreeName(page: Page, name: string) {
	const input = page.getByTestId('tree-rename-input');
	await input.fill(name);
	await input.press('Enter');
	await expect(page.locator(`[data-name="${name}"]`)).toBeVisible();
}

/** Crea un nodo dai pulsanti in cima alla sidebar e ne conferma il nome. */
export async function createTreeNode(page: Page, kind: 'file' | 'folder', name: string) {
	await page.getByRole('button', { name: kind === 'file' ? 'New file' : 'New folder' }).click();
	await confirmTreeName(page, name);
}

/** Crea un nodo dal menu contestuale di un'altra riga e ne conferma il nome. */
export async function createTreeNodeFrom(
	page: Page,
	reference: string | null,
	kind: 'file' | 'folder',
	name: string
) {
	await treeContextMenu(page, reference, kind === 'file' ? 'Nuovo file' : 'Nuova cartella');
	await confirmTreeName(page, name);
}
