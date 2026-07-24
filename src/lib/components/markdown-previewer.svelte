<script lang="ts">
	import { onMount } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { marked } from "marked";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";

	let markdownText = $state("# Hello Markdown\n\nType something on the left to see the preview on the right!\n\n- **Bold** text\n- *Italic* text\n- [A link](https://google.com)\n\n```javascript\nconsole.log('Hello World');\n```");

	let rawHtml = $derived(marked.parse(markdownText) as string);
	let htmlContent = $state("");

	$effect(() => {
		if (typeof window !== "undefined") {
			import("dompurify").then((dompurify) => {
				htmlContent = dompurify.default.sanitize(rawHtml);
			});
		}
	});
</script>

<ModeWatcher />

<Resizable.PaneGroup direction="horizontal" autoSaveId="markdown-previewer-layout">
	<Resizable.Pane defaultSize={50}>
		<div class="flex h-screen flex-col p-4">
			<Textarea
				id="markdown-input"
				class="flex-1 resize-none font-mono p-4 leading-relaxed"
				placeholder="Type your markdown here..."
				bind:value={markdownText}
			/>
		</div>
	</Resizable.Pane>
	<Resizable.Handle />
	<Resizable.Pane defaultSize={50}>
		<div class="h-screen overflow-y-auto p-8">
			<article class="prose prose-slate dark:prose-invert max-w-none">
				{@html htmlContent}
			</article>
		</div>
	</Resizable.Pane>
</Resizable.PaneGroup>
