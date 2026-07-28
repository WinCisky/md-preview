/**
 * Stato condiviso dell'albero dei file: la sidebar lo disegna, l'editor lo usa
 * per sapere quale file è aperto. Vive a livello di modulo perché la sidebar è
 * renderizzata da markdown-previewer.svelte, quindi entrambi stanno nella
 * stessa isola Astro e vedono la stessa istanza.
 *
 * L'ordinamento dei fratelli è automatico (cartelle prima, poi per nome): il
 * drag & drop sposta un nodo dentro un'altra cartella, non ne cambia la
 * posizione tra i fratelli.
 */

import { SvelteSet } from "svelte/reactivity";
import {
	ROOT_ID,
	createNode,
	deleteNode,
	getLatestFile,
	listNodes,
	moveNode,
	renameNode,
	setNodeExpanded,
	type FileNode,
	type NodeType,
} from "$lib/files-db";

export const SEED_FILE_NAME = "welcome";

export const SEED_CONTENT =
	"# Hello Markdown\n\nType something on the left to see the preview on the right!\n\n- **Bold** text\n- *Italic* text\n- [A link](https://google.com)\n\n```javascript\nconsole.log('Hello World');\n```";

export interface TreeNode extends FileNode {
	children: TreeNode[];
}

let nodes = $state<FileNode[]>([]);
let activeFileId = $state<string | null>(null);
let selectedId = $state<string | null>(null);
let renamingId = $state<string | null>(null);
let dropTargetId = $state<string | null>(null);
const expanded = new SvelteSet<string>();

/**
 * Il nodo trascinato. Variabile semplice e non stato reattivo: durante il
 * "dragover" `dataTransfer.getData()` ritorna sempre stringa vuota (i dati sono
 * in modalità protetta finché non avviene il drop), quindi la validità dello
 * spostamento va decisa leggendo da qui.
 */
let dragId: string | null = null;

/**
 * Callback registrata dall'editor per caricare il contenuto di un file. Con
 * `null` l'editor si svuota: non c'è più nessun file su cui scrivere.
 */
let onOpenFile: ((node: FileNode | null) => void) | null = null;

function sortSiblings(a: TreeNode, b: TreeNode): number {
	if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name);
}

function buildTree(list: FileNode[]): TreeNode[] {
	const byId = new Map<string, TreeNode>();
	for (const node of list) {
		byId.set(node.id, { ...node, children: [] });
	}
	const roots: TreeNode[] = [];
	for (const node of byId.values()) {
		const parent = byId.get(node.parentId);
		// Un parentId che non esiste più (dato inconsistente) non deve far
		// sparire il nodo dall'albero: lo si tratta come figlio della radice.
		if (parent && parent.id !== node.id) parent.children.push(node);
		else roots.push(node);
	}
	for (const node of byId.values()) {
		node.children.sort(sortSiblings);
	}
	roots.sort(sortSiblings);
	return roots;
}

function findNode(nodeId: string | null): FileNode | undefined {
	if (nodeId === null) return undefined;
	return nodes.find((node) => node.id === nodeId);
}

/** True se `candidate` è `nodeId` stesso o uno dei suoi discendenti. */
function isSelfOrDescendant(candidate: string, nodeId: string): boolean {
	let current: string | undefined = candidate;
	const seen = new Set<string>();
	while (current && current !== ROOT_ID) {
		if (current === nodeId) return true;
		if (seen.has(current)) return false; // ciclo: fermarsi invece di girare a vuoto
		seen.add(current);
		current = findNode(current)?.parentId;
	}
	return false;
}

/** Nome libero dentro `parentId`, aggiungendo "-2", "-3", … finché non collide. */
function uniqueName(name: string, parentId: string, ignoreId?: string): string {
	const taken = new Set(
		nodes
			.filter((node) => node.parentId === parentId && node.id !== ignoreId)
			.map((node) => node.name.toLowerCase()),
	);
	if (!taken.has(name.toLowerCase())) return name;

	let suffix = 2;
	while (taken.has(`${name}-${suffix}`.toLowerCase())) suffix++;
	return `${name}-${suffix}`;
}

/**
 * Ricarica l'albero e riallinea il set delle cartelle aperte a quanto salvato.
 * Il set resta la sorgente per il rendering, ma il suo contenuto viene dal
 * campo `expanded` dei nodi: è così che l'apertura sopravvive a un ricaricamento
 * della pagina.
 */
async function reload(): Promise<void> {
	nodes = await listNodes();
	expanded.clear();
	for (const node of nodes) {
		if (node.expanded) expanded.add(node.id);
	}
}

/** Apre o chiude una cartella subito a schermo, salvando in background. */
function persistExpanded(nodeId: string, value: boolean) {
	if (value) expanded.add(nodeId);
	else expanded.delete(nodeId);
	const node = findNode(nodeId);
	// La copia in memoria va aggiornata anche qui: il prossimo reload()
	// ricostruisce il set proprio da questo campo.
	if (node) node.expanded = value;
	setNodeExpanded(nodeId, value).catch((err) => {
		console.error("Impossibile salvare lo stato della cartella:", err);
	});
}

export const fileTree = {
	get nodes() {
		return nodes;
	},
	get tree() {
		return buildTree(nodes);
	},
	get activeFileId() {
		return activeFileId;
	},
	get activeFile() {
		return findNode(activeFileId);
	},
	get selectedId() {
		return selectedId;
	},
	get renamingId() {
		return renamingId;
	},
	get dropTargetId() {
		return dropTargetId;
	},
	get dragId() {
		return dragId;
	},

	isExpanded(nodeId: string): boolean {
		return expanded.has(nodeId);
	},

	toggleExpanded(nodeId: string) {
		persistExpanded(nodeId, !expanded.has(nodeId));
	},

	/** L'editor si registra qui per ricevere il file da aprire. */
	setOpenFileHandler(handler: (node: FileNode | null) => void) {
		onOpenFile = handler;
	},

	/**
	 * Carica l'albero e, la primissima volta che l'app viene aperta, crea il
	 * file di esempio così che la sidebar non parta vuota.
	 */
	async init(): Promise<void> {
		await reload();
		if (nodes.length === 0) {
			await createNode({
				type: "file",
				name: SEED_FILE_NAME,
				parentId: ROOT_ID,
				content: SEED_CONTENT,
			});
			await reload();
		}
		const latest = await getLatestFile();
		if (latest) this.open(latest.id);
	},

	select(nodeId: string) {
		selectedId = nodeId;
	},

	/** Seleziona un file e ne chiede l'apertura all'editor. */
	open(nodeId: string) {
		const node = findNode(nodeId);
		if (!node || node.type !== "file") return;
		selectedId = nodeId;
		activeFileId = nodeId;
		onOpenFile?.(node);
	},

	/**
	 * Dove finisce un nuovo nodo: dentro la cartella selezionata, accanto al
	 * file selezionato, altrimenti nella radice.
	 */
	targetParentId(referenceId: string | null = selectedId): string {
		const reference = findNode(referenceId);
		if (!reference) return ROOT_ID;
		return reference.type === "folder" ? reference.id : reference.parentId;
	},

	/** Crea un file o una cartella ed entra subito in modalità rinomina. */
	async create(type: NodeType, referenceId: string | null = selectedId): Promise<void> {
		const parentId = this.targetParentId(referenceId);
		const name = uniqueName(type === "folder" ? "new folder" : "untitled", parentId);
		const created = await createNode({ type, name, parentId });
		// Prima di reload(), che ricostruisce il set dai nodi: così l'apertura
		// automatica della cartella che accoglie il nuovo nodo non viene persa.
		if (parentId !== ROOT_ID) await setNodeExpanded(parentId, true);
		await reload();
		selectedId = created.id;
		renamingId = created.id;
		if (type === "file") this.open(created.id);
	},

	startRename(nodeId: string) {
		renamingId = nodeId;
	},

	cancelRename() {
		renamingId = null;
	},

	/** Conferma la rinomina. Un nome vuoto o invariato viene semplicemente ignorato. */
	async rename(nodeId: string, rawName: string): Promise<void> {
		renamingId = null;
		const node = findNode(nodeId);
		const name = rawName.trim();
		if (!node || name.length === 0 || name === node.name) return;
		await renameNode(nodeId, uniqueName(name, node.parentId, nodeId));
		await reload();
	},

	/** True se `nodeId` può essere spostato dentro `parentId`. */
	canMove(nodeId: string | null, parentId: string): boolean {
		const node = findNode(nodeId);
		if (!node || node.parentId === parentId) return false;
		if (parentId === ROOT_ID) return true;
		const parent = findNode(parentId);
		if (!parent || parent.type !== "folder") return false;
		// Spostare una cartella dentro se stessa o in un suo discendente
		// staccherebbe quel ramo dall'albero.
		return !isSelfOrDescendant(parentId, node.id);
	},

	async move(nodeId: string, parentId: string): Promise<void> {
		if (!this.canMove(nodeId, parentId)) return;
		const node = findNode(nodeId)!;
		const name = uniqueName(node.name, parentId, nodeId);
		if (name !== node.name) await renameNode(nodeId, name);
		await moveNode(nodeId, parentId);
		if (parentId !== ROOT_ID) await setNodeExpanded(parentId, true);
		await reload();
	},

	/** Elimina un nodo con tutto il suo contenuto. Ritorna false se annullato. */
	async remove(nodeId: string): Promise<boolean> {
		const node = findNode(nodeId);
		if (!node) return false;
		const hasChildren = nodes.some((other) => other.parentId === nodeId);
		if (hasChildren && !window.confirm(`Eliminare "${node.name}" e tutto il suo contenuto?`)) {
			return false;
		}

		const removedIds = new Set(
			nodes.filter((other) => isSelfOrDescendant(other.id, nodeId)).map((other) => other.id),
		);
		const closingActiveFile = activeFileId !== null && removedIds.has(activeFileId);
		// L'editor va staccato *prima* della cancellazione: così l'eventuale
		// modifica ancora in attesa del debounce finisce nel file mentre esiste
		// ancora, invece di fallire (o peggio, di ricrearlo) subito dopo.
		if (closingActiveFile) {
			activeFileId = null;
			onOpenFile?.(null);
		}
		if (selectedId && removedIds.has(selectedId)) selectedId = null;

		await deleteNode(nodeId);
		await reload();

		if (closingActiveFile) {
			const latest = await getLatestFile();
			if (latest) this.open(latest.id);
		}
		return true;
	},

	startDrag(nodeId: string) {
		dragId = nodeId;
	},

	endDrag() {
		dragId = null;
		dropTargetId = null;
	},

	setDropTarget(parentId: string | null) {
		dropTargetId = parentId;
	},

	/** Conclude un drag & drop sull'elemento indicato. */
	async drop(parentId: string): Promise<void> {
		const nodeId = dragId;
		this.endDrag();
		if (nodeId) await this.move(nodeId, parentId);
	},

	/**
	 * Allinea la copia in memoria dopo che l'editor ha salvato. Senza questo la
	 * cache resterebbe al contenuto letto all'avvio, e riaprire lo stesso file
	 * dopo averlo lasciato riporterebbe indietro il testo.
	 */
	syncContent(nodeId: string, content: string) {
		const node = findNode(nodeId);
		if (node) node.content = content;
	},
};
