<script lang="ts">
    import { Button } from "$lib/components/ui/button/index.js";

    import SidebarFolder from "$lib/components/sidebar-folder.svelte";
	import SidebarFile from "$lib/components/sidebar-file.svelte";

    import FolderIcon from "@lucide/svelte/icons/folder";
    import FolderOpenIcon from "@lucide/svelte/icons/folder-open";

    import { slide } from 'svelte/transition';

	let { expanded = $bindable(false), name, childrens } = $props();

	function toggle() {
		expanded = !expanded;
	}
</script>

<Button variant="ghost" size="icon" class="w-fit h-fit" onclick={toggle}>
	{#if expanded}
			<FolderOpenIcon class="w-4 h-4" />
		{:else}
			<FolderIcon class="w-4 h-4" />
		{/if}
	<span class="font-normal pl-1">
		{name}
	</span>
</Button>

{#if expanded}
	<ul transition:slide={{ duration: 300 }} class="flex flex-col pl-3 ml-2 border-l">
		{#each childrens as children}
			<li class="flex flex-col">
				{#if children.type === 'folder'}
					<SidebarFolder {...children} />
				{:else}
					<SidebarFile {...children} />
				{/if}
			</li>
		{/each}
	</ul>
{/if}
