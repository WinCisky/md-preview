<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FolderIcon from "@lucide/svelte/icons/folder";
	import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
	// Import di sé: l'albero è ricorsivo.
	import SidebarFolder from "./sidebar-folder.svelte";
	import SidebarFile from "./sidebar-file.svelte";
	import TreeMenuItems from "./tree-menu-items.svelte";
	import TreeRenameInput from "./tree-rename-input.svelte";
	import { fileTree, type TreeNode } from "$lib/file-tree.svelte";
	import { cn } from "$lib/utils";
	import { slide } from "svelte/transition";

	let { node }: { node: TreeNode } = $props();

	const renaming = $derived(fileTree.renamingId === node.id);
	const expanded = $derived(fileTree.isExpanded(node.id));
	const isDropTarget = $derived(fileTree.dropTargetId === node.id);

	function handleDragStart(event: DragEvent) {
		fileTree.startDrag(node.id);
		event.dataTransfer?.setData("application/x-md-node", node.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}

	function handleDragOver(event: DragEvent) {
		if (!fileTree.canMove(fileTree.dragId, node.id)) return;
		// preventDefault solo quando lo spostamento è legale: altrove il browser
		// mostra il cursore "vietato" senza che serva altro codice.
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		fileTree.setDropTarget(node.id);
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		event.stopPropagation();
		fileTree.drop(node.id);
	}
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger
		draggable={!renaming}
		data-testid="tree-folder"
		data-name={node.name}
		data-drop-target={isDropTarget ? "" : undefined}
		class={cn(
			"block rounded-md border border-transparent",
			isDropTarget && "border-primary bg-primary/10",
		)}
		ondragstart={handleDragStart}
		ondragend={() => fileTree.endDrag()}
		ondragover={handleDragOver}
		ondrop={handleDrop}
		onpointerdown={() => fileTree.select(node.id)}
	>
		{#if renaming}
			<TreeRenameInput {node} />
		{:else}
			<Button
				variant="ghost"
				size="sm"
				class={cn(
					"h-7 w-full justify-start px-1.5 font-normal",
					fileTree.selectedId === node.id && "bg-muted text-foreground",
				)}
				onclick={() => fileTree.toggleExpanded(node.id)}
			>
				{#if expanded}
					<FolderOpenIcon class="size-4" />
				{:else}
					<FolderIcon class="size-4" />
				{/if}
				<span class="truncate pl-1">{node.name}</span>
			</Button>
		{/if}
	</ContextMenu.Trigger>
	<TreeMenuItems {node} />
</ContextMenu.Root>

{#if expanded}
	<ul transition:slide={{ duration: 300 }} class="ml-2 flex flex-col border-l pl-3">
		{#each node.children as child (child.id)}
			<li class="flex flex-col">
				{#if child.type === "folder"}
					<SidebarFolder node={child} />
				{:else}
					<SidebarFile node={child} />
				{/if}
			</li>
		{/each}
	</ul>
{/if}
