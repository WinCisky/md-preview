<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import FileIcon from "@lucide/svelte/icons/file";

	let { name } = $props();
</script>

<Button variant="ghost" size="icon" class="w-fit h-fit">
	<FileIcon class="w-4 h-4" />
	<span class="font-normal pl-1">
		{name}
	</span>
</Button>