<script lang="ts">
	import SidebarFolder from "$lib/components/sidebar-folder.svelte";
	import SidebarFile from "$lib/components/sidebar-file.svelte";
	import TreeMenuItems from "$lib/components/tree-menu-items.svelte";

	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FilePlusIcon from "@lucide/svelte/icons/file-plus";
	import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
	import { fileTree } from "$lib/file-tree.svelte";
	import { ROOT_ID } from "$lib/files-db";
	import { cn } from "$lib/utils";

	const isRootDropTarget = $derived(fileTree.dropTargetId === ROOT_ID);

	// Lo spazio vuoto sotto l'elenco è la destinazione "radice", sia per il drop
	// sia per il menu contestuale. Sta fuori dalle righe: annidare un
	// ContextMenu.Trigger dentro l'altro aprirebbe due menu insieme.
	function handleDragOver(event: DragEvent) {
		if (!fileTree.canMove(fileTree.dragId, ROOT_ID)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		fileTree.setDropTarget(ROOT_ID);
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		fileTree.drop(ROOT_ID);
	}
</script>

<Sidebar.Root>
	<Sidebar.Content>
		<Sidebar.Group class="min-h-0 flex-1">
			<Sidebar.GroupLabel>Documents</Sidebar.GroupLabel>
			<!-- GroupAction è posizionato in assoluto a right-3: il secondo pulsante
			     va spostato a sinistra per non finirci sopra. -->
			<Sidebar.GroupAction
				class="right-9"
				title="New file"
				onclick={() => fileTree.create("file")}
			>
				<FilePlusIcon />
				<span class="sr-only">New file</span>
			</Sidebar.GroupAction>
			<Sidebar.GroupAction title="New folder" onclick={() => fileTree.create("folder")}>
				<FolderPlusIcon />
				<span class="sr-only">New folder</span>
			</Sidebar.GroupAction>
			<Sidebar.GroupContent class="flex min-h-0 flex-1 flex-col px-2">
				{#each fileTree.tree as node (node.id)}
					{#if node.type === "folder"}
						<SidebarFolder {node} />
					{:else}
						<SidebarFile {node} />
					{/if}
				{/each}

				<ContextMenu.Root>
					<ContextMenu.Trigger
						data-testid="tree-root"
						class={cn(
							"mt-1 block min-h-16 flex-1 rounded-md border border-transparent",
							isRootDropTarget && "border-primary bg-primary/10",
						)}
						onpointerdown={() => fileTree.select(ROOT_ID)}
						ondragover={handleDragOver}
						ondrop={handleDrop}
						ondragleave={() => fileTree.setDropTarget(null)}
					></ContextMenu.Trigger>
					<TreeMenuItems node={null} />
				</ContextMenu.Root>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>
</Sidebar.Root>
