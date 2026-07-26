/**
 * Layer di persistenza locale (IndexedDB) per la cronologia dei documenti
 * markdown modificati/incollati nell'editor. Nessuna dipendenza esterna:
 * wrapper nativo su indexedDB con due object store:
 *
 * - "documents": un record per ogni documento distinto (creato quando si
 *   incolla contenuto che sostituisce interamente il testo corrente, o al
 *   primo edit dell'editor). Contiene sempre l'ultimo contenuto noto.
 * - "revisions": lo storico delle modifiche di ciascun documento (una per
 *   ogni salvataggio debounced durante la digitazione, o per un incolla
 *   parziale dentro un documento già esistente).
 *
 * Tutte le funzioni sono pensate per essere chiamate solo lato client
 * (dentro onMount/effect/event handler di Svelte), mai a livello di modulo,
 * così da non essere eseguite durante il pass di SSR di Astro.
 */

const DB_NAME = "md-preview-history";
const DB_VERSION = 1;
const DOCUMENTS_STORE = "documents";
const REVISIONS_STORE = "revisions";

export type DocumentOrigin = "typed" | "pasted";
export type ChangeType = "initial" | "edit" | "paste";

export interface DocumentRecord {
	id: string;
	title: string;
	origin: DocumentOrigin;
	createdAt: number;
	updatedAt: number;
	latestContent: string;
}

export interface RevisionRecord {
	id: number;
	documentId: string;
	content: string;
	changeType: ChangeType;
	timestamp: number;
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
			if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
				const documents = db.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
				documents.createIndex("updatedAt", "updatedAt");
			}
			if (!db.objectStoreNames.contains(REVISIONS_STORE)) {
				const revisions = db.createObjectStore(REVISIONS_STORE, {
					keyPath: "id",
					autoIncrement: true,
				});
				revisions.createIndex("documentId", "documentId");
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Deriva un titolo leggibile dalla prima riga non vuota del contenuto. */
function deriveTitle(content: string): string {
	const firstLine = content
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return "Senza titolo";
	const cleaned = firstLine.replace(/^#+\s*/, "").trim();
	if (!cleaned) return "Senza titolo";
	return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

/** Crea un nuovo documento con la sua revisione iniziale. Ritorna l'id creato. */
export async function createDocument(content: string, origin: DocumentOrigin): Promise<string> {
	const db = await openDb();
	const id = crypto.randomUUID();
	const now = Date.now();
	const document: DocumentRecord = {
		id,
		title: deriveTitle(content),
		origin,
		createdAt: now,
		updatedAt: now,
		latestContent: content,
	};
	const revision: Omit<RevisionRecord, "id"> = {
		documentId: id,
		content,
		changeType: "initial",
		timestamp: now,
	};
	const tx = db.transaction([DOCUMENTS_STORE, REVISIONS_STORE], "readwrite");
	tx.objectStore(DOCUMENTS_STORE).put(document);
	tx.objectStore(REVISIONS_STORE).add(revision);
	await transactionDone(tx);
	db.close();
	return id;
}

/** Aggiunge una revisione a un documento esistente e ne aggiorna il contenuto/orario. */
export async function addRevision(
	documentId: string,
	content: string,
	changeType: ChangeType,
): Promise<void> {
	const db = await openDb();
	const now = Date.now();
	const tx = db.transaction([DOCUMENTS_STORE, REVISIONS_STORE], "readwrite");
	const documentsStore = tx.objectStore(DOCUMENTS_STORE);
	const existing = await requestToPromise<DocumentRecord | undefined>(documentsStore.get(documentId));
	if (!existing) {
		throw new Error(`Documento ${documentId} non trovato: impossibile aggiungere la revisione.`);
	}
	const updated: DocumentRecord = { ...existing, updatedAt: now, latestContent: content };
	documentsStore.put(updated);
	const revision: Omit<RevisionRecord, "id"> = { documentId, content, changeType, timestamp: now };
	tx.objectStore(REVISIONS_STORE).add(revision);
	await transactionDone(tx);
	db.close();
}

/** Elenca tutti i documenti, dal più recentemente aggiornato al meno recente. */
export async function listDocuments(): Promise<DocumentRecord[]> {
	const db = await openDb();
	const tx = db.transaction(DOCUMENTS_STORE, "readonly");
	const all = await requestToPromise(tx.objectStore(DOCUMENTS_STORE).getAll());
	db.close();
	return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Elenca le revisioni di un documento, dalla più recente alla meno recente. */
export async function listRevisions(documentId: string): Promise<RevisionRecord[]> {
	const db = await openDb();
	const tx = db.transaction(REVISIONS_STORE, "readonly");
	const all = await requestToPromise(
		tx.objectStore(REVISIONS_STORE).index("documentId").getAll(documentId),
	);
	db.close();
	return all.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Recupera il documento aggiornato più di recente, o undefined se la
 * cronologia è vuota. Usa l'indice "updatedAt" con un cursore in ordine
 * inverso così da leggere un solo record invece di caricare (e ordinare)
 * l'intero contenuto di tutti i documenti.
 */
export async function getLatestDocument(): Promise<DocumentRecord | undefined> {
	const db = await openDb();
	const tx = db.transaction(DOCUMENTS_STORE, "readonly");
	const cursor = await requestToPromise(
		tx.objectStore(DOCUMENTS_STORE).index("updatedAt").openCursor(null, "prev"),
	);
	const result = cursor?.value as DocumentRecord | undefined;
	db.close();
	return result;
}

/** Recupera un singolo documento per id. */
export async function getDocument(documentId: string): Promise<DocumentRecord | undefined> {
	const db = await openDb();
	const tx = db.transaction(DOCUMENTS_STORE, "readonly");
	const result = await requestToPromise(tx.objectStore(DOCUMENTS_STORE).get(documentId));
	db.close();
	return result;
}

/** Elimina un documento e tutte le sue revisioni. */
export async function deleteDocument(documentId: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction([DOCUMENTS_STORE, REVISIONS_STORE], "readwrite");
	tx.objectStore(DOCUMENTS_STORE).delete(documentId);
	const revisionsStore = tx.objectStore(REVISIONS_STORE);
	const index = revisionsStore.index("documentId");
	const cursorRequest = index.openCursor(documentId);
	await new Promise<void>((resolve, reject) => {
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (cursor) {
				cursor.delete();
				cursor.continue();
			} else {
				resolve();
			}
		};
		cursorRequest.onerror = () => reject(cursorRequest.error);
	});
	await transactionDone(tx);
	db.close();
}

/** Svuota completamente la cronologia (tutti i documenti e tutte le revisioni). */
export async function clearAllHistory(): Promise<void> {
	const db = await openDb();
	const tx = db.transaction([DOCUMENTS_STORE, REVISIONS_STORE], "readwrite");
	tx.objectStore(DOCUMENTS_STORE).clear();
	tx.objectStore(REVISIONS_STORE).clear();
	await transactionDone(tx);
	db.close();
}
