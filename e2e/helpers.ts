import { expect, type Page } from '@playwright/test';

export type StoreName = 'nodes' | 'attachments';

/** A transparent 1x1 PNG: enough to check that the preview renders it. */
export const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface SeedFile {
	name: string;
	mimeType: string;
	/** Content in base64; for images a 1x1 PNG is enough. */
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
 * Opens the files database from the page context, replicating the schema of
 * src/lib/files-db.ts. It has to be kept aligned with the app's: whichever of
 * the two requests (test or app) wins the race to open the database first, the
 * object stores must be created correctly — and above all with the same
 * version, otherwise opening with the lower version fails with a VersionError.
 *
 * Defined as a string and evaluated in the browser because it is needed
 * identically inside several `page.evaluate` calls, which cannot capture
 * functions from the Node context.
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

/** Rebuilds a File from its base64 content, on the browser side. */
function toFile(file: SeedFile): File {
	const binary = atob(file.base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new File([bytes], file.name, { type: file.mimeType });
}

/** Source of the two functions above, injected into every page.evaluate. */
const BROWSER_HELPERS = `${openFilesDb};\n${toFile};`;

/**
 * Runs in the browser a function that can use `openFilesDb()` and `toFile()`.
 * Playwright serializes the callback body, so the helpers have to be shipped as
 * source and reinstalled on the spot.
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
 * Counts the records present in one of the object stores, reading directly from
 * the browser. Used with `expect(...).toPass()` to wait deterministically for
 * the editor's debounced save (SAVE_DEBOUNCE_MS in markdown-previewer.svelte)
 * to have actually been written, instead of relying on a fixed wait.
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

/** Every node in the tree as it is written to IndexedDB. */
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

/** Waits for the given file to have been saved with the expected content. */
export async function waitForNodeContent(page: Page, name: string, expected: RegExp) {
	await expect(async () => {
		const nodes = await readNodes(page);
		const node = nodes.find((candidate) => candidate.name === name);
		expect(node?.content ?? '').toMatch(expected);
	}).toPass({ timeout: 10000 });
}

/**
 * Opens the editor and waits for the Svelte island to be hydrated. On the first
 * open the app creates the sample file, whose content is the one expected here.
 */
export async function gotoEditor(page: Page) {
	await page.goto('./');
	await waitForHydration(page);
	await expect(page.getByTestId('tree-file')).toHaveCount(1);
}

/**
 * Waits for the first usable screen: the preview is empty in the served HTML
 * (sanitization happens on the client only), so until the heading appears the
 * paste/drop handlers are not attached yet and a synthetic event would be lost.
 */
export async function waitForHydration(page: Page) {
	await expect(page.getByRole('heading', { name: 'Hello Markdown', level: 1 })).toBeVisible();
}

/** Pastes files into the textarea, as Ctrl+V on a screenshot would. */
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

/** Sends a sequence of drag events carrying files onto the editor's drop zone. */
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

/** Drops files onto the editor's drop zone. */
export async function dropFiles(page: Page, files: SeedFile[]) {
	await dragFiles(page, files, ['dragenter', 'dragover', 'drop']);
}

/**
 * Drags a tree row onto another (or onto the root area with `targetName` null).
 * The events are synthetic: native drag & drop cannot be driven reliably from
 * Playwright. Returns true if the dragover was accepted, that is, if the app
 * considers the move legal.
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
 * Drags a row over another and stays there: no drop, no dragend, so the target
 * highlight stays on screen and can be asserted.
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

/** Opens the context menu on a tree row and picks an entry. */
export async function treeContextMenu(page: Page, nodeName: string | null, item: string) {
	const target = nodeName
		? page.locator(`[data-name="${nodeName}"]`)
		: page.getByTestId('tree-root');
	await target.click({ button: 'right' });
	await page.getByRole('menuitem', { name: item }).click();
}

/**
 * Confirms the name of the just-created node (which is born already in rename
 * mode) and waits for the renamed row to appear: the write to IndexedDB and the
 * resulting tree reload are async, so right after Enter the row still carries
 * the provisional name.
 */
export async function confirmTreeName(page: Page, name: string) {
	const input = page.getByTestId('tree-rename-input');
	await input.fill(name);
	await input.press('Enter');
	await expect(page.locator(`[data-name="${name}"]`)).toBeVisible();
}

/** Creates a node from the buttons at the top of the sidebar and confirms its name. */
export async function createTreeNode(page: Page, kind: 'file' | 'folder', name: string) {
	await page.getByRole('button', { name: kind === 'file' ? 'New file' : 'New folder' }).click();
	await confirmTreeName(page, name);
}

/** Creates a node from another row's context menu and confirms its name. */
export async function createTreeNodeFrom(
	page: Page,
	reference: string | null,
	kind: 'file' | 'folder',
	name: string
) {
	await treeContextMenu(page, reference, kind === 'file' ? 'New file' : 'New folder');
	await confirmTreeName(page, name);
}
