<script lang="ts">
	/**
	 * Voci del menu contestuale dell'albero. Con `node` null il menu è quello
	 * dell'area vuota della sidebar: si può solo creare, e nella radice.
	 */
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FilePlusIcon from "@lucide/svelte/icons/file-plus";
	import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
	import PencilIcon from "@lucide/svelte/icons/pencil";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import { fileTree, type TreeNode } from "$lib/file-tree.svelte";

	let { node = null }: { node?: TreeNode | null } = $props();

	const referenceId = $derived(node?.id ?? null);
</script>

<ContextMenu.Content class="w-48">
	<ContextMenu.Item onSelect={() => fileTree.create("file", referenceId)}>
		<FilePlusIcon />
		Nuovo file
	</ContextMenu.Item>
	<ContextMenu.Item onSelect={() => fileTree.create("folder", referenceId)}>
		<FolderPlusIcon />
		Nuova cartella
	</ContextMenu.Item>
	{#if node}
		<ContextMenu.Separator />
		<ContextMenu.Item onSelect={() => fileTree.startRename(node.id)}>
			<PencilIcon />
			Rinomina
		</ContextMenu.Item>
		<ContextMenu.Item variant="destructive" onSelect={() => fileTree.remove(node.id)}>
			<Trash2Icon />
			Elimina
		</ContextMenu.Item>
	{/if}
</ContextMenu.Content>
