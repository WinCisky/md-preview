<script lang="ts">
	import FileIcon from "@lucide/svelte/icons/file";
	import { useSidebar } from "$lib/components/ui/sidebar/index.js";
	import { fileTree, type Reveal } from "$lib/file-tree.svelte";
	import type { DocumentResult, SnippetPart } from "$lib/content-search";
	import { cn } from "$lib/utils";

	let { results }: { results: DocumentResult[] } = $props();

	const sidebar = useSidebar();

	// Lines shown per document before the "more" button.
	const COLLAPSED_LINES = 5;
	let expandedIds = $state<string[]>([]);

	function visibleLines(result: DocumentResult) {
		return expandedIds.includes(result.node.id) ? result.lines : result.lines.slice(0, COLLAPSED_LINES);
	}

	function hiddenLines(result: DocumentResult) {
		return result.lines.length + result.moreLines - visibleLines(result).length;
	}

	const totalMatches = $derived(results.reduce((sum, result) => sum + result.matchCount, 0));

	function open(nodeId: string, reveal?: Reveal) {
		fileTree.open(nodeId, reveal);
		// On mobile the sidebar is a sheet covering the editor.
		if (sidebar.isMobile) sidebar.setOpenMobile(false);
	}
</script>

{#snippet highlighted(parts: SnippetPart[])}
	{#each parts as part, index (index)}
		{#if part.match}
			<mark class="bg-yellow-300/70 text-foreground rounded-[2px] dark:bg-yellow-500/40">{part.text}</mark>
		{:else}{part.text}{/if}
	{/each}
{/snippet}

<div class="flex flex-col gap-1" data-testid="search-results">
	{#if results.length === 0}
		<p class="text-muted-foreground px-1.5 py-1 text-sm" data-testid="tree-search-empty">
			No matches
		</p>
	{:else}
		<p class="text-muted-foreground px-1.5 text-xs" data-testid="search-summary">
			{totalMatches}
			{totalMatches === 1 ? "match" : "matches"} in {results.length}
			{results.length === 1 ? "file" : "files"}
		</p>
	{/if}

	{#each results as result (result.node.id)}
		{@const hidden = hiddenLines(result)}
		<div class="flex flex-col" data-testid="search-result" data-name={result.node.name}>
			<button
				type="button"
				class={cn(
					"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm",
					fileTree.activeFileId === result.node.id && "bg-muted",
				)}
				title={[...result.path, result.node.name].join(" / ")}
				onclick={() => open(result.node.id)}
			>
				<FileIcon class="size-4 shrink-0" />
				<span class="min-w-0 flex-1 truncate">
					<span class="font-medium">{@render highlighted(result.nameParts)}</span>
					{#if result.path.length > 0}
						<span class="text-muted-foreground text-xs" data-testid="search-result-path">
							{result.path.join(" / ")}
						</span>
					{/if}
				</span>
				{#if result.matchCount > 0}
					<span
						class="bg-sidebar-accent text-muted-foreground shrink-0 rounded-full px-1.5 text-xs tabular-nums"
						data-testid="search-result-count">{result.matchCount}</span
					>
				{/if}
			</button>

			{#each visibleLines(result) as match (match.line)}
				<button
					type="button"
					class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ml-3 flex min-w-0 items-baseline gap-2 rounded-md border-l px-1.5 py-0.5 text-left text-xs"
					data-testid="search-match"
					data-line={match.line + 1}
					onclick={() => open(result.node.id, { start: match.start, end: match.end })}
				>
					<span class="text-muted-foreground w-6 shrink-0 text-right tabular-nums">{match.line + 1}</span>
					<span class="min-w-0 flex-1 font-mono break-words whitespace-pre-wrap line-clamp-2"
						>{@render highlighted(match.parts)}</span
					>
				</button>
			{/each}
			{#if hidden > 0}
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground ml-3 py-0.5 pl-10 text-left text-xs"
					data-testid="search-more"
					onclick={() => {
						if (expandedIds.includes(result.node.id)) open(result.node.id);
						else expandedIds.push(result.node.id);
					}}
				>
					+{hidden} more {hidden === 1 ? "line" : "lines"}
				</button>
			{/if}
		</div>
	{/each}
</div>
