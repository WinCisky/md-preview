<script lang="ts">
	import SidebarFolder from "$lib/components/sidebar-folder.svelte";
	import SidebarFile from "$lib/components/sidebar-file.svelte";
	import TreeMenuItems from "$lib/components/tree-menu-items.svelte";

	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
	import FilePlusIcon from "@lucide/svelte/icons/file-plus";
	import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
	import SearchIcon from "@lucide/svelte/icons/search";
	import { tick } from "svelte";
	import { fileTree } from "$lib/file-tree.svelte";
	import { ROOT_ID } from "$lib/files-db";
	import { cn } from "$lib/utils";

	const isRootDropTarget = $derived(fileTree.dropTargetId === ROOT_ID);
	const visibleTree = $derived(fileTree.visibleTree);

	let searchOpen = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);

	async function toggleSearch() {
		searchOpen = !searchOpen;
		if (searchOpen) {
			await tick();
			searchInput?.focus();
		} else {
			fileTree.searchQuery = "";
		}
	}

	function handleSearchKeydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			searchOpen = false;
			fileTree.searchQuery = "";
		}
	}

	// The empty space below the list is the "root" target, both for the drop and
	// for the context menu. It sits outside the rows: nesting one
	// ContextMenu.Trigger inside another would open two menus at once.
	function handleDragOver(event: DragEvent) {
		fileTree.dragOver(event, ROOT_ID);
	}

	function handleDrop(event: DragEvent) {
		fileTree.dropEvent(event, ROOT_ID);
	}
</script>

<Sidebar.Root>
	<Sidebar.Content>
		<Sidebar.Group class="min-h-0 flex-1">
			<Sidebar.GroupLabel>Documents</Sidebar.GroupLabel>
			<!-- GroupAction is absolutely positioned at right-3: the other buttons
			     have to be shifted left so they do not land on top of it. -->
			<Sidebar.GroupAction
				class={cn("right-15", searchOpen && "bg-sidebar-accent text-sidebar-accent-foreground")}
				title="Search files"
				aria-pressed={searchOpen}
				onclick={toggleSearch}
			>
				<SearchIcon />
				<span class="sr-only">Search files</span>
			</Sidebar.GroupAction>
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
				{#if searchOpen}
					<Sidebar.Input
						bind:ref={searchInput}
						bind:value={fileTree.searchQuery}
						type="search"
						placeholder="Search files…"
						aria-label="Search files"
						data-testid="tree-search"
						class="mb-2"
						onkeydown={handleSearchKeydown}
					/>
				{/if}
				{#if fileTree.searching && visibleTree.length === 0}
					<p class="text-muted-foreground px-1.5 py-1 text-sm" data-testid="tree-search-empty">
						No matching files
					</p>
				{/if}
				{#each visibleTree as node (node.id)}
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
