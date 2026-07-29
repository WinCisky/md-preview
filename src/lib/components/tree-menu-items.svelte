<script lang="ts">
	/**
	 * Context-menu entries for the tree. With `node` null this is the menu for
	 * the empty area of the sidebar: you can only create, and only in the root.
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
		New file
	</ContextMenu.Item>
	<ContextMenu.Item onSelect={() => fileTree.create("folder", referenceId)}>
		<FolderPlusIcon />
		New folder
	</ContextMenu.Item>
	{#if node}
		<ContextMenu.Separator />
		<ContextMenu.Item onSelect={() => fileTree.startRename(node.id)}>
			<PencilIcon />
			Rename
		</ContextMenu.Item>
		<ContextMenu.Item variant="destructive" onSelect={() => fileTree.remove(node.id)}>
			<Trash2Icon />
			Delete
		</ContextMenu.Item>
	{/if}
</ContextMenu.Content>
