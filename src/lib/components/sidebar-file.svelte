<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FileIcon from "@lucide/svelte/icons/file";
	import FileClockIcon from "@lucide/svelte/icons/file-clock";
	import TreeMenuItems from "./tree-menu-items.svelte";
	import TreeRenameInput from "./tree-rename-input.svelte";
	import { fileTree, isOldFile, type TreeNode } from "$lib/file-tree.svelte";
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
	// Not updated over time while the page stays open: good enough for a
	// "not touched in a month" hint.
	const old = $derived(isOldFile(node));

	function handleDragStart(event: DragEvent) {
		fileTree.startDrag(node.id);
		event.dataTransfer?.setData("application/x-md-node", node.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	}

	function handleDragOver(event: DragEvent) {
		if (fileTree.dragOver(event, dropParentId)) event.stopPropagation();
	}

	function handleDrop(event: DragEvent) {
		event.stopPropagation();
		fileTree.dropEvent(event, dropParentId);
	}
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger
		draggable={!renaming}
		data-testid="tree-file"
		data-name={node.name}
		data-old={old ? "" : undefined}
		class={cn("block rounded-md border border-transparent", old && "opacity-60")}
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
				{#if old}
					<FileClockIcon class="size-4" />
				{:else}
					<FileIcon class="size-4" />
				{/if}
				<span class="truncate pl-1">{node.name}</span>
			</Button>
		{/if}
	</ContextMenu.Trigger>
	<TreeMenuItems {node} />
</ContextMenu.Root>
