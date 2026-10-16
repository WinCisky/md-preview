<script lang="ts">
	/**
	 * Inline rename field, used both in the tree rows and in the editor header.
	 * Enter confirms, Escape cancels, a click outside or Tab confirms.
	 * `settled` prevents a second commit/cancel once the field has resolved.
	 *
	 * The field is opened programmatically (right after creating a node, or
	 * from a menu), so it has to defend itself from losing focus by accident:
	 * - for CLICK_OUT_GRACE_MS after mounting, clicks outside are ignored (a
	 *   stray double click on the "new" button, a misclick, …);
	 * - a blur that is not caused by the user (e.g. the context menu restoring
	 *   focus to its trigger once it closes) gives the focus back to the field
	 *   instead of confirming it with the placeholder name.
	 */
	import { onMount } from "svelte";
	import { fileTree } from "$lib/file-tree.svelte";
	import { cn } from "$lib/utils";

	const CLICK_OUT_GRACE_MS = 50;
	// Upper bound to the focus reclaims: something that insists on stealing
	// the focus must not end up in an endless tug of war.
	const MAX_REFOCUS = 5;

	let {
		node,
		class: className = "",
		testId = "tree-rename-input",
		oncommit,
		oncancel,
	}: {
		node: { id: string; name: string };
		class?: string;
		testId?: string;
		/** Defaults to renaming the node through the file tree. */
		oncommit?: (value: string) => void;
		oncancel?: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let value = $state(node.name);
	// svelte-ignore state_referenced_locally
	const initialName = node.name;
	let inputEl: HTMLInputElement | null = $state(null);
	let settled = false;
	let mountedAt = 0;
	let tabbing = false;
	let refocusCount = 0;

	onMount(() => {
		mountedAt = performance.now();
		inputEl?.focus();
		inputEl?.select();

		// Capture phase: runs before the handlers of whatever was clicked (tree
		// rows select themselves on pointerdown), so the rename is committed
		// first.
		const onPointerDown = (event: PointerEvent) => {
			if (settled || !inputEl) return;
			if (event.target instanceof Node && inputEl.contains(event.target)) return;
			if (performance.now() - mountedAt < CLICK_OUT_GRACE_MS) return;
			commit();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	});

	function commit() {
		if (settled) return;
		settled = true;
		if (oncommit) oncommit(value);
		else fileTree.rename(node.id, value);
	}

	function cancel() {
		if (settled) return;
		settled = true;
		if (oncancel) oncancel();
		else fileTree.cancelRename();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancel();
		} else if (event.key === "Tab") {
			tabbing = true;
		}
	}

	function handleBlur() {
		if (settled) return;
		// Moving away with the keyboard is a deliberate choice.
		if (tabbing) {
			commit();
			return;
		}
		// The whole window lost focus (alt-tab, devtools): the browser gives the
		// focus back to the field on return, nothing to do.
		if (!document.hasFocus()) return;
		// A user click outside has already committed in onPointerDown: any other
		// blur was not asked for by the user, take the focus back.
		if (refocusCount >= MAX_REFOCUS) {
			commit();
			return;
		}
		refocusCount++;
		setTimeout(() => {
			if (settled || !inputEl || document.activeElement === inputEl) return;
			inputEl.focus();
			// Only re-select if the user has not started typing yet.
			if (value === initialName) inputEl.select();
		}, 0);
	}
</script>

<input
	bind:this={inputEl}
	bind:value
	data-testid={testId}
	class={cn(
		"border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 w-full rounded-md border px-1.5 text-sm outline-none focus-visible:ring-3",
		className,
	)}
	onkeydown={handleKeydown}
	onblur={handleBlur}
/>
