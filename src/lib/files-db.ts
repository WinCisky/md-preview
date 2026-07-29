/**
 * Local persistence layer (IndexedDB) for the app's file tree. No external
 * dependencies: a native wrapper around indexedDB with two object stores:
 *
 * - "nodes": one record per file or folder. For a file only the latest known
 *   content is kept: there is no revision history.
 * - "attachments": the files (images or generic attachments) dragged/pasted
 *   into the editor. The markdown does not contain the bytes but only an
 *   "attachment:<id>" reference, resolved to an object URL at render time. An
 *   attachment no longer referenced by the text is deleted.
 *
 * All the functions are meant to be called on the client only (inside Svelte
 * onMount/effect/event handlers), never at module level, so they are not run
 * during Astro's SSR pass.
 */

const DB_NAME = "md-preview-files";
const DB_VERSION = 1;
const NODES_STORE = "nodes";
const ATTACHMENTS_STORE = "attachments";

export type NodeType = "file" | "folder";

/**
 * Sentinel for the nodes at the top of the tree. IndexedDB does not index null
 * keys: with `parentId: null` the top-level nodes would be invisible to any
 * query on the "parentId" index.
 */
export const ROOT_ID = "root";

export interface FileNode {
	id: string;
	type: NodeType;
	parentId: string;
	name: string;
	/** Empty string for folders. */
	content: string;
	/**
	 * Folders only: whether their content is shown expanded in the sidebar.
	 * Absent on records written before the field existed, and in that case it
	 * counts as "collapsed".
	 */
	expanded?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface AttachmentRecord {
	id: string;
	/** null until the file containing it has been created. */
	nodeId: string | null;
	name: string;
	mimeType: string;
	size: number;
	blob: Blob;
	createdAt: number;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

function openDb(): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined") {
		return Promise.reject(new Error("IndexedDB is not available in this environment."));
	}
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(NODES_STORE)) {
				const nodes = db.createObjectStore(NODES_STORE, { keyPath: "id" });
				nodes.createIndex("parentId", "parentId");
				nodes.createIndex("updatedAt", "updatedAt");
			}
			// The "nodeId" index does not contain records with a null nodeId: the
			// still-"orphaned" attachments stay invisible to per-file queries
			// until adoptAttachments() hooks them up.
			if (!db.objectStoreNames.contains(ATTACHMENTS_STORE)) {
				const attachments = db.createObjectStore(ATTACHMENTS_STORE, { keyPath: "id" });
				attachments.createIndex("nodeId", "nodeId");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Every node in the tree. The tree is small: the hierarchy is built in memory. */
export async function listNodes(): Promise<FileNode[]> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readonly");
	const all = await requestToPromise(tx.objectStore(NODES_STORE).getAll());
	db.close();
	return all;
}

/** Fetches a single node by id. */
export async function getNode(nodeId: string): Promise<FileNode | undefined> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readonly");
	const result = await requestToPromise(tx.objectStore(NODES_STORE).get(nodeId));
	db.close();
	return result;
}

/** Creates a file or a folder. Returns the created record. */
export async function createNode(options: {
	type: NodeType;
	name: string;
	parentId: string;
	content?: string;
}): Promise<FileNode> {
	const db = await openDb();
	const now = Date.now();
	const node: FileNode = {
		id: crypto.randomUUID(),
		type: options.type,
		parentId: options.parentId,
		name: options.name,
		content: options.type === "file" ? (options.content ?? "") : "",
		createdAt: now,
		updatedAt: now,
	};
	const tx = db.transaction(NODES_STORE, "readwrite");
	tx.objectStore(NODES_STORE).put(node);
	await transactionDone(tx);
	db.close();
	return node;
}

/** Applies a partial change to an existing node, updating its `updatedAt`. */
async function patchNode(nodeId: string, patch: Partial<FileNode>): Promise<FileNode> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readwrite");
	const store = tx.objectStore(NODES_STORE);
	const existing = await requestToPromise<FileNode | undefined>(store.get(nodeId));
	if (!existing) {
		db.close();
		throw new Error(`Node ${nodeId} not found.`);
	}
	const updated: FileNode = { ...existing, ...patch, updatedAt: Date.now() };
	store.put(updated);
	await transactionDone(tx);
	db.close();
	return updated;
}

export function renameNode(nodeId: string, name: string): Promise<FileNode> {
	return patchNode(nodeId, { name });
}

export function updateContent(nodeId: string, content: string): Promise<FileNode> {
	return patchNode(nodeId, { content });
}

export function moveNode(nodeId: string, parentId: string): Promise<FileNode> {
	return patchNode(nodeId, { parentId });
}

/**
 * Expands or collapses a folder. It deliberately does not go through
 * patchNode(): expanding a folder is not a change to the document, so
 * `updatedAt` must not be touched or the last opened file and the ordering
 * would be affected.
 */
export async function setNodeExpanded(nodeId: string, expanded: boolean): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readwrite");
	const store = tx.objectStore(NODES_STORE);
	const existing = await requestToPromise<FileNode | undefined>(store.get(nodeId));
	if (existing) store.put({ ...existing, expanded });
	await transactionDone(tx);
	db.close();
}

/**
 * Deletes a node with its whole subtree and the attachments of the files it
 * contains. The ids are collected before the write transaction: an IndexedDB
 * transaction closes itself as soon as the current microtask ends with no
 * requests in flight, so it cannot span an `await` on an external promise.
 */
export async function deleteNode(nodeId: string): Promise<void> {
	const all = await listNodes();
	const childrenByParent = new Map<string, FileNode[]>();
	for (const node of all) {
		const siblings = childrenByParent.get(node.parentId);
		if (siblings) siblings.push(node);
		else childrenByParent.set(node.parentId, [node]);
	}

	const doomed: string[] = [];
	const queue = [nodeId];
	while (queue.length > 0) {
		const current = queue.pop()!;
		doomed.push(current);
		for (const child of childrenByParent.get(current) ?? []) {
			queue.push(child.id);
		}
	}

	const db = await openDb();
	const tx = db.transaction([NODES_STORE, ATTACHMENTS_STORE], "readwrite");
	const nodesStore = tx.objectStore(NODES_STORE);
	const attachmentsIndex = tx.objectStore(ATTACHMENTS_STORE).index("nodeId");
	for (const id of doomed) {
		nodesStore.delete(id);
		deleteByCursor(attachmentsIndex.openCursor(id));
	}
	await transactionDone(tx);
	db.close();
}

/** Deletes every record the cursor reaches. Does not await: the transaction does. */
function deleteByCursor(cursorRequest: IDBRequest<IDBCursorWithValue | null>): void {
	cursorRequest.onsuccess = () => {
		const cursor = cursorRequest.result;
		if (!cursor) return;
		cursor.delete();
		cursor.continue();
	};
}

/**
 * The most recently updated file, or undefined if there are none. Uses the
 * "updatedAt" index with a reverse-order cursor, skipping folders.
 */
export async function getLatestFile(): Promise<FileNode | undefined> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readonly");
	const cursorRequest = tx.objectStore(NODES_STORE).index("updatedAt").openCursor(null, "prev");
	const result = await new Promise<FileNode | undefined>((resolve, reject) => {
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor) {
				resolve(undefined);
				return;
			}
			const node = cursor.value as FileNode;
			if (node.type === "file") resolve(node);
			else cursor.continue();
		};
		cursorRequest.onerror = () => reject(cursorRequest.error);
	});
	db.close();
	return result;
}

/**
 * Saves a file as an attachment. `nodeId` can be null when the file is inserted
 * before the editor has an active file: adoptAttachments() will hook it up as
 * soon as the id is available.
 */
export async function saveAttachment(file: File, nodeId: string | null): Promise<AttachmentRecord> {
	const db = await openDb();
	const record: AttachmentRecord = {
		id: crypto.randomUUID(),
		nodeId,
		name: file.name,
		mimeType: file.type || "application/octet-stream",
		size: file.size,
		blob: file,
		createdAt: Date.now(),
	};
	const tx = db.transaction(ATTACHMENTS_STORE, "readwrite");
	tx.objectStore(ATTACHMENTS_STORE).put(record);
	await transactionDone(tx);
	db.close();
	return record;
}

/** Fetches a single attachment by id. */
export async function getAttachment(attachmentId: string): Promise<AttachmentRecord | undefined> {
	const db = await openDb();
	const tx = db.transaction(ATTACHMENTS_STORE, "readonly");
	const result = await requestToPromise(tx.objectStore(ATTACHMENTS_STORE).get(attachmentId));
	db.close();
	return result;
}

/**
 * Lists a file's attachments, from oldest to newest. Several files dropped
 * together land in the same millisecond: the name breaks the tie, otherwise
 * their on-screen order would change on every read.
 */
export async function listAttachments(nodeId: string): Promise<AttachmentRecord[]> {
	const db = await openDb();
	const tx = db.transaction(ATTACHMENTS_STORE, "readonly");
	const all = await requestToPromise(
		tx.objectStore(ATTACHMENTS_STORE).index("nodeId").getAll(nodeId),
	);
	db.close();
	return all.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
}

/** Hooks up to a file attachments created when the id was not yet known. */
export async function adoptAttachments(attachmentIds: string[], nodeId: string): Promise<void> {
	if (attachmentIds.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(ATTACHMENTS_STORE, "readwrite");
	const store = tx.objectStore(ATTACHMENTS_STORE);
	for (const attachmentId of attachmentIds) {
		const existing = await requestToPromise<AttachmentRecord | undefined>(store.get(attachmentId));
		if (existing) store.put({ ...existing, nodeId });
	}
	await transactionDone(tx);
	db.close();
}

/** Deletes the given attachments: used when the text no longer references them. */
export async function deleteAttachments(attachmentIds: string[]): Promise<void> {
	if (attachmentIds.length === 0) return;
	const db = await openDb();
	const tx = db.transaction(ATTACHMENTS_STORE, "readwrite");
	const store = tx.objectStore(ATTACHMENTS_STORE);
	for (const attachmentId of attachmentIds) {
		store.delete(attachmentId);
	}
	await transactionDone(tx);
	db.close();
}
