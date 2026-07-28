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
	// Un file non è una destinazione: il drop viene dirottato sulla cartella che
	// lo contiene, così rilasciare sopra una riga qualsiasi fa la cosa attesa.
	// L'evidenziazione però resta alla sola cartella di destinazione: accenderla
	// anche qui illuminerebbe tutti i file che stanno dentro quella cartella. Il
	// bordo trasparente serve solo a tenere le righe allineate a quelle delle
	// cartelle, che quel bordo lo mostrano quando ricevono un drop.
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
