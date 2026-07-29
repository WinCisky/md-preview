<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FileIcon from "@lucide/svelte/icons/file";
	import TreeMenuItems from "./tree-menu-items.svelte";
	import TreeRenameInput from "./tree-rename-input.svelte";
	import { fileTree, type TreeNode } from "$lib/file-tree.svelte";
	import { cn } from "$lib/utils";

	let { node }: { node: TreeNode } = $props();

	const renaming = $derived(fileTree.renamingId === node.id);
	// A file is not a target: the drop is redirected to the folder containing
	// it, so releasing over any row does the expected thing. The highlight
	// however stays on the destination folder alone: lighting it up here too
	// would light up every file inside that folder. The transparent border is
	// only there to keep these rows aligned with the folder rows, which do show
	// that border when they receive a drop.
	const dropParentId = $derived(node.parentId);

	function handleDragStart(event: DragEvent) {
		fileTree.startDrag(node.id);
		event.dataTransfer?.setData("application/x-md-node", node.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}

	function handleDragOver(event: DragEvent) {
		if (!fileTree.canMove(fileTree.dragId, dropParentId)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		fileTree.setDropTarget(dropParentId);
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		event.stopPropagation();
		fileTree.drop(dropParentId);
	}
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger
		draggable={!renaming}
		data-testid="tree-file"
		data-name={node.name}
		class="block rounded-md border border-transparent"
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
				onclick={() => fileTree.open(node.id)}
			>
				<FileIcon class="size-4" />
				<span class="truncate pl-1">{node.name}</span>
			</Button>
		{/if}
	</ContextMenu.Trigger>
	<TreeMenuItems {node} />
</ContextMenu.Root>
