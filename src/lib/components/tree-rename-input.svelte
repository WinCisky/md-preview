<script lang="ts">
	/**
	 * Campo di rinomina inline che prende il posto della riga dell'albero.
	 * Enter conferma, Escape annulla, il blur conferma. `settled` evita che il
	 * blur emesso dallo smontaggio del campo riapra la strada a un secondo
	 * salvataggio dopo Enter o Escape.
	 */
	import { fileTree, type TreeNode } from "$lib/file-tree.svelte";

	let { node }: { node: TreeNode } = $props();

	let value = $state(node.name);
	let inputEl: HTMLInputElement | null = $state(null);
	let settled = false;

	$effect(() => {
		inputEl?.focus();
		inputEl?.select();
	});

	function commit() {
		if (settled) return;
		settled = true;
		fileTree.rename(node.id, value);
	}

	function cancel() {
		if (settled) return;
		settled = true;
		fileTree.cancelRename();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		}
	}
</script>

<input
	bind:this={inputEl}
	bind:value
	data-testid="tree-rename-input"
	class="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 w-full rounded-md border px-1.5 text-sm outline-none focus-visible:ring-3"
	onkeydown={handleKeydown}
	onblur={commit}
/>
