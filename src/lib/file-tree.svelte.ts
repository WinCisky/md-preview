/**
 * Shared file-tree state: the sidebar renders it, the editor uses it to know
 * which file is open. It lives at module level because the sidebar is
 * rendered by markdown-previewer.svelte, so both sit inside the same Astro
 * island and see the same instance.
 *
 * Sibling ordering is automatic (folders first, then by name): drag & drop
 * moves a node into another folder, it does not change its position among
 * siblings.
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

/**
 * Id of the last file opened, so a reload reopens it. `updatedAt` alone is not
 * enough: it only moves when a file is modified, so a file opened but not
 * edited would lose to the last one written.
 */
const LAST_OPENED_KEY = "md-preview:last-opened-file";

function readLastOpened(): string | null {
	try {
		return localStorage.getItem(LAST_OPENED_KEY);
	} catch {
		return null;
	}
}

function writeLastOpened(nodeId: string) {
	try {
		localStorage.setItem(LAST_OPENED_KEY, nodeId);
	} catch {
		// Storage unavailable (private mode, quota): fall back to updatedAt.
	}
}

/** Files untouched for longer than this are shown as "old" in the sidebar. */
export const OLD_FILE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function isOldFile(node: FileNode, now = Date.now()): boolean {
	return node.type === "file" && now - node.updatedAt > OLD_FILE_AGE_MS;
}

/** Extensions accepted when markdown files are dropped from the OS. */
const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkdn?|mdwn|mdtxt|mdtext)$/i;

function isMarkdownFile(file: File): boolean {
	return MARKDOWN_EXTENSION.test(file.name) || file.type === "text/markdown";
}

/** True if the drag carries files from outside the page (the OS file manager). */
function isExternalFileDrag(event: DragEvent): boolean {
	return dragId === null && (event.dataTransfer?.types.includes("Files") ?? false);
}

/**
 * An external drag has no "dragend" on our elements and no reliable
 * "dragleave" when the pointer leaves the window: the highlight is cleared
 * when "dragover" stops arriving (the browser fires it every ~50ms while the
 * pointer is over a target that accepts it).
 */
const EXTERNAL_HOVER_TIMEOUT_MS = 150;
let externalHoverTimer: ReturnType<typeof setTimeout> | null = null;

function armExternalHoverTimeout() {
	if (externalHoverTimer !== null) clearTimeout(externalHoverTimer);
	externalHoverTimer = setTimeout(() => {
		externalHoverTimer = null;
		dropTargetId = null;
	}, EXTERNAL_HOVER_TIMEOUT_MS);
}

function clearExternalHover() {
	if (externalHoverTimer !== null) clearTimeout(externalHoverTimer);
	externalHoverTimer = null;
	dropTargetId = null;
}

export interface TreeNode extends FileNode {
	children: TreeNode[];
}

let nodes = $state<FileNode[]>([]);
let activeFileId = $state<string | null>(null);
let selectedId = $state<string | null>(null);
let renamingId = $state<string | null>(null);
let dropTargetId = $state<string | null>(null);
let searchQuery = $state("");
const expanded = new SvelteSet<string>();

/**
 * The dragged node. A plain variable and not reactive state: during
 * "dragover" `dataTransfer.getData()` always returns an empty string (the data
 * is in protected mode until the drop happens), so whether the move is valid
 * has to be decided by reading from here.
 */
let dragId: string | null = null;

/**
 * Callback registered by the editor to load a file's content. With `null` the
 * editor empties itself: there is no file left to write into.
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
		// A parentId that no longer exists (inconsistent data) must not make the
		// node vanish from the tree: treat it as a child of the root instead.
		if (parent && parent.id !== node.id) parent.children.push(node);
		else roots.push(node);
	}
	for (const node of byId.values()) {
		node.children.sort(sortSiblings);
	}
	roots.sort(sortSiblings);
	return roots;
}

/**
 * Keeps only the files whose name contains `query` (case-insensitive), plus
 * the folders leading to them. Folders with no matching file are dropped.
 */
function filterTree(tree: TreeNode[], query: string): TreeNode[] {
	const result: TreeNode[] = [];
	for (const node of tree) {
		if (node.type === "file") {
			if (node.name.toLowerCase().includes(query)) result.push(node);
			continue;
		}
		const children = filterTree(node.children, query);
		if (children.length > 0) result.push({ ...node, children });
	}
	return result;
}

function findNode(nodeId: string | null): FileNode | undefined {
	if (nodeId === null) return undefined;
	return nodes.find((node) => node.id === nodeId);
}

/** True if `candidate` is `nodeId` itself or one of its descendants. */
function isSelfOrDescendant(candidate: string, nodeId: string): boolean {
	let current: string | undefined = candidate;
	const seen = new Set<string>();
	while (current && current !== ROOT_ID) {
		if (current === nodeId) return true;
		if (seen.has(current)) return false; // cycle: stop instead of spinning
		seen.add(current);
		current = findNode(current)?.parentId;
	}
	return false;
}

/** A free name inside `parentId`, appending "-2", "-3", … until it stops colliding. */
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
 * Reloads the tree and realigns the set of open folders with what was saved.
 * The set stays the source for rendering, but its content comes from the
 * nodes' `expanded` field: that is how the open state survives a page reload.
 */
async function reload(): Promise<void> {
	nodes = await listNodes();
	expanded.clear();
	for (const node of nodes) {
		if (node.expanded) expanded.add(node.id);
	}
}

/** Opens or closes a folder on screen right away, saving in the background. */
function persistExpanded(nodeId: string, value: boolean) {
	if (value) expanded.add(nodeId);
	else expanded.delete(nodeId);
	const node = findNode(nodeId);
	// The in-memory copy has to be updated here too: the next reload()
	// rebuilds the set from this very field.
	if (node) node.expanded = value;
	setNodeExpanded(nodeId, value).catch((err) => {
		console.error("Could not save folder state:", err);
	});
}

export const fileTree = {
	get nodes() {
		return nodes;
	},
	get tree() {
		return buildTree(nodes);
	},
	/** The tree filtered by the search query (the full tree when it is empty). */
	get visibleTree() {
		const tree = buildTree(nodes);
		const query = searchQuery.trim().toLowerCase();
		return query ? filterTree(tree, query) : tree;
	},
	get searchQuery() {
		return searchQuery;
	},
	set searchQuery(value: string) {
		searchQuery = value;
	},
	/** True while a search filters the tree: every folder is shown open. */
	get searching() {
		return searchQuery.trim().length > 0;
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
		return searchQuery.trim().length > 0 || expanded.has(nodeId);
	},

	toggleExpanded(nodeId: string) {
		persistExpanded(nodeId, !expanded.has(nodeId));
	},

	/** The editor registers here to receive the file to open. */
	setOpenFileHandler(handler: (node: FileNode | null) => void) {
		onOpenFile = handler;
	},

	/**
	 * Loads the tree and, the very first time the app is opened, creates the
	 * sample file so the sidebar does not start out empty.
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
		const lastOpened = findNode(readLastOpened());
		if (lastOpened?.type === "file") {
			this.open(lastOpened.id);
			return;
		}
		const latest = await getLatestFile();
		if (latest) this.open(latest.id);
	},

	select(nodeId: string) {
		selectedId = nodeId;
	},

	/** Selects a file and asks the editor to open it. */
	open(nodeId: string) {
		const node = findNode(nodeId);
		if (!node || node.type !== "file") return;
		selectedId = nodeId;
		activeFileId = nodeId;
		writeLastOpened(nodeId);
		onOpenFile?.(node);
	},

	/**
	 * Where a new node ends up: inside the selected folder, next to the
	 * selected file, otherwise in the root.
	 */
	targetParentId(referenceId: string | null = selectedId): string {
		const reference = findNode(referenceId);
		if (!reference) return ROOT_ID;
		return reference.type === "folder" ? reference.id : reference.parentId;
	},

	/** Creates a file or a folder and enters rename mode straight away. */
	async create(type: NodeType, referenceId: string | null = selectedId): Promise<void> {
		const parentId = this.targetParentId(referenceId);
		const name = uniqueName(type === "folder" ? "new folder" : "untitled", parentId);
		const created = await createNode({ type, name, parentId });
		// Before reload(), which rebuilds the set from the nodes: this way the
		// automatic opening of the folder receiving the new node is not lost.
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

	/** Confirms the rename. An empty or unchanged name is simply ignored. */
	async rename(nodeId: string, rawName: string): Promise<void> {
		renamingId = null;
		const node = findNode(nodeId);
		const name = rawName.trim();
		if (!node || name.length === 0 || name === node.name) return;
		await renameNode(nodeId, uniqueName(name, node.parentId, nodeId));
		await reload();
	},

	/** True if `nodeId` can be moved inside `parentId`. */
	canMove(nodeId: string | null, parentId: string): boolean {
		const node = findNode(nodeId);
		if (!node || node.parentId === parentId) return false;
		if (parentId === ROOT_ID) return true;
		const parent = findNode(parentId);
		if (!parent || parent.type !== "folder") return false;
		// Moving a folder inside itself or into one of its descendants would
		// detach that branch from the tree.
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

	/** Deletes a node with everything inside it. Returns false if cancelled. */
	async remove(nodeId: string): Promise<boolean> {
		const node = findNode(nodeId);
		if (!node) return false;
		const hasChildren = nodes.some((other) => other.parentId === nodeId);
		if (hasChildren && !window.confirm(`Delete "${node.name}" and all its contents?`)) {
			return false;
		}

		const removedIds = new Set(
			nodes.filter((other) => isSelfOrDescendant(other.id, nodeId)).map((other) => other.id),
		);
		const closingActiveFile = activeFileId !== null && removedIds.has(activeFileId);
		// The editor has to be detached *before* the deletion: that way an edit
		// still waiting on the debounce lands in the file while it still
		// exists, instead of failing (or worse, recreating it) right after.
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

	/** Ends a drag & drop on the given element. */
	async drop(parentId: string): Promise<void> {
		const nodeId = dragId;
		this.endDrag();
		if (nodeId) await this.move(nodeId, parentId);
	},

	/**
	 * Shared "dragover" logic for the tree targets, both for internal moves and
	 * for files dragged in from the OS. Returns true when the drop is accepted
	 * (the event has then been preventDefault-ed and the target highlighted).
	 */
	dragOver(event: DragEvent, parentId: string): boolean {
		const external = isExternalFileDrag(event);
		const accepted = external
			? parentId === ROOT_ID || findNode(parentId)?.type === "folder"
			: this.canMove(dragId, parentId);
		if (!accepted) return false;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = external ? "copy" : "move";
		dropTargetId = parentId;
		if (external) armExternalHoverTimeout();
		return true;
	},

	/** Shared "drop" logic for the tree targets (see dragOver). */
	dropEvent(event: DragEvent, parentId: string) {
		event.preventDefault();
		if (dragId !== null) {
			this.drop(parentId).catch((err) => console.error("Could not move the node:", err));
			return;
		}
		// Read synchronously: the FileList is emptied once the handler returns.
		const files = Array.from(event.dataTransfer?.files ?? []);
		clearExternalHover();
		this.importFiles(files, parentId).catch((err) => {
			console.error("Could not import the files:", err);
		});
	},

	/**
	 * Adds markdown files from the OS to the tree inside `parentId`, then opens
	 * the last one. Other file types are ignored. Nodes have no extension (the
	 * export adds it), so ".md" is stripped from the name.
	 */
	async importFiles(files: File[], parentId: string): Promise<void> {
		const markdown = files.filter(isMarkdownFile);
		if (markdown.length === 0) return;
		let last: FileNode | null = null;
		for (const file of markdown) {
			const content = await file.text();
			const base = file.name.replace(MARKDOWN_EXTENSION, "").trim() || "untitled";
			last = await createNode({
				type: "file",
				name: uniqueName(base, parentId),
				parentId,
				content,
			});
			// So that uniqueName sees it when the next file has the same name.
			nodes.push(last);
		}
		if (parentId !== ROOT_ID) await setNodeExpanded(parentId, true);
		await reload();
		if (last) this.open(last.id);
	},

	/**
	 * Realigns the in-memory copy after the editor has saved. Without this the
	 * cache would stay at the content read at startup, and reopening the same
	 * file after leaving it would bring the old text back.
	 */
	syncContent(nodeId: string, content: string) {
		const node = findNode(nodeId);
		if (node) {
			node.content = content;
			node.updatedAt = Date.now();
		}
	},
};
