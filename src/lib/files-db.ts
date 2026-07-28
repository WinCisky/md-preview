/**
 * Layer di persistenza locale (IndexedDB) per l'albero dei file dell'app.
 * Nessuna dipendenza esterna: wrapper nativo su indexedDB con due object store:
 *
 * - "nodes": un record per ogni file o cartella. Di un file si conserva solo
 *   l'ultimo contenuto noto: non esiste uno storico delle revisioni.
 * - "attachments": i file (immagini o allegati generici) trascinati/incollati
 *   nell'editor. Il markdown non contiene i byte ma solo un riferimento
 *   "attachment:<id>", risolto a un object URL al momento del rendering.
 *   Un allegato non più referenziato dal testo viene cancellato.
 *
 * Tutte le funzioni sono pensate per essere chiamate solo lato client
 * (dentro onMount/effect/event handler di Svelte), mai a livello di modulo,
 * così da non essere eseguite durante il pass di SSR di Astro.
 */

const DB_NAME = "md-preview-files";
const DB_VERSION = 1;
const NODES_STORE = "nodes";
const ATTACHMENTS_STORE = "attachments";

export type NodeType = "file" | "folder";

/**
 * Sentinella per i nodi in cima all'albero. IndexedDB non indicizza le chiavi
 * nulle: con `parentId: null` i nodi di primo livello sarebbero invisibili a
 * qualsiasi query sull'indice "parentId".
 */
export const ROOT_ID = "root";

export interface FileNode {
	id: string;
	type: NodeType;
	parentId: string;
	name: string;
	/** Stringa vuota per le cartelle. */
	content: string;
	/**
	 * Solo per le cartelle: se il loro contenuto è mostrato aperto nella
	 * sidebar. Assente sui record scritti prima che il campo esistesse, e in
	 * quel caso vale come "chiusa".
	 */
	expanded?: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface AttachmentRecord {
	id: string;
	/** null finché il file che lo contiene non è ancora stato creato. */
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
		return Promise.reject(new Error("IndexedDB non disponibile in questo ambiente."));
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
			// L'indice "nodeId" non contiene i record con nodeId null: gli allegati
			// ancora "orfani" restano invisibili alle query per file finché
			// adoptAttachments() non li aggancia.
			if (!db.objectStoreNames.contains(ATTACHMENTS_STORE)) {
				const attachments = db.createObjectStore(ATTACHMENTS_STORE, { keyPath: "id" });
				attachments.createIndex("nodeId", "nodeId");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Tutti i nodi dell'albero. L'albero è piccolo: la gerarchia si costruisce in memoria. */
export async function listNodes(): Promise<FileNode[]> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readonly");
	const all = await requestToPromise(tx.objectStore(NODES_STORE).getAll());
	db.close();
	return all;
}

/** Recupera un singolo nodo per id. */
export async function getNode(nodeId: string): Promise<FileNode | undefined> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readonly");
	const result = await requestToPromise(tx.objectStore(NODES_STORE).get(nodeId));
	db.close();
	return result;
}

/** Crea un file o una cartella. Ritorna il record creato. */
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

/** Applica una modifica parziale a un nodo esistente, aggiornandone `updatedAt`. */
async function patchNode(nodeId: string, patch: Partial<FileNode>): Promise<FileNode> {
	const db = await openDb();
	const tx = db.transaction(NODES_STORE, "readwrite");
	const store = tx.objectStore(NODES_STORE);
	const existing = await requestToPromise<FileNode | undefined>(store.get(nodeId));
	if (!existing) {
		db.close();
		throw new Error(`Nodo ${nodeId} non trovato.`);
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
 * Apre o chiude una cartella. Non passa da patchNode() di proposito: aprire una
 * cartella non è una modifica del documento, quindi `updatedAt` non va toccato
 * o l'ultimo file aperto e l'ordinamento ne risentirebbero.
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
 * Elimina un nodo con tutto il suo sottoalbero e gli allegati dei file
 * contenuti. La raccolta degli id avviene prima della transazione di scrittura:
 * una transazione IndexedDB si chiude da sola appena il microtask corrente
 * finisce senza richieste in volo, quindi non può attraversare un `await` su
 * una promise esterna.
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

/** Cancella ogni record raggiunto dal cursore. Non attende: la transazione lo fa. */
function deleteByCursor(cursorRequest: IDBRequest<IDBCursorWithValue | null>): void {
	cursorRequest.onsuccess = () => {
		const cursor = cursorRequest.result;
		if (!cursor) return;
		cursor.delete();
		cursor.continue();
	};
}

/**
 * Il file aggiornato più di recente, o undefined se non ce ne sono. Usa
 * l'indice "updatedAt" con un cursore in ordine inverso, saltando le cartelle.
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
 * Salva un file come allegato. `nodeId` può essere null quando il file viene
 * inserito prima che l'editor abbia un file attivo: sarà adoptAttachments() ad
 * agganciarlo appena l'id è disponibile.
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

/** Recupera un singolo allegato per id. */
export async function getAttachment(attachmentId: string): Promise<AttachmentRecord | undefined> {
	const db = await openDb();
	const tx = db.transaction(ATTACHMENTS_STORE, "readonly");
	const result = await requestToPromise(tx.objectStore(ATTACHMENTS_STORE).get(attachmentId));
	db.close();
	return result;
}

/**
 * Elenca gli allegati di un file, dal più vecchio al più recente. Più file
 * rilasciati insieme finiscono nello stesso millisecondo: il nome fa da
 * spareggio, altrimenti il loro ordine a schermo cambierebbe ad ogni lettura.
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

/** Aggancia a un file allegati creati quando l'id non era ancora noto. */
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

/** Elimina gli allegati indicati: usato quando il testo non li referenzia più. */
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
