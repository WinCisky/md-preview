<script lang="ts">
	import { onMount } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { basicSetup, EditorView } from "codemirror";
	import { Compartment, EditorState } from "@codemirror/state";
	import { json } from "@codemirror/lang-json";
	import { githubLight } from "@ddietr/codemirror-themes/github-light";
	import { githubDark } from "@ddietr/codemirror-themes/github-dark";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import AlertCircleIcon from "@lucide/svelte/icons/alert-circle";
	import AlertTriangleIcon from "@lucide/svelte/icons/alert-triangle";
	import { processJsonInput } from "$lib/utils.js";

	let editorContainer: HTMLDivElement;
	let editorView: EditorView | null = $state(null);
	const themeCompartment = new Compartment();

	let inputJson = $state("");
	let errorMessage = $state("");
	let warningMessage = $state("");

	function setEditorContent(content: string) {
		if (!editorView) return;
		editorView.dispatch({
			changes: {
				from: 0,
				to: editorView.state.doc.length,
				insert: content
			}
		});
	}

	onMount(() => {
		editorView = new EditorView({
			parent: editorContainer,
			extensions: [
				basicSetup,
				json(),
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				EditorView.contentAttributes.of({ tabindex: "0" }),
				EditorView.theme({
					"&": { height: "100%" },
					".cm-scroller": { overflow: "auto" }
				}),
				themeCompartment.of(mode.current === "dark" ? githubDark : githubLight)
			]
		});

		return () => {
			editorView?.destroy();
			editorView = null;
		};
	});

	// Auto-format the right editor whenever the left input changes.
	$effect(() => {
		if (!editorView) return;

		if (inputJson.trim() === "") {
			errorMessage = "";
			warningMessage = "";
			setEditorContent("");
			return;
		}

		const result = processJsonInput(inputJson);

		if (result.status === "error") {
			errorMessage = result.message;
			warningMessage = "";
			return;
		}

		setEditorContent(result.output);
		errorMessage = "";
		warningMessage = result.status === "repaired" ? result.message : "";
	});

	// Keep the editor theme in sync with the active color scheme.
	$effect(() => {
		if (!editorView) return;
		editorView.dispatch({
			effects: themeCompartment.reconfigure(
				mode.current === "dark" ? githubDark : githubLight
			)
		});
	});
</script>

<ModeWatcher />

<Resizable.PaneGroup direction="horizontal" autoSaveId="md-preview-layout">
	<Resizable.Pane defaultSize={35}>
		<div class="flex h-screen flex-col gap-2 p-4">
			<Textarea
				class="flex-1 resize-none font-mono"
				placeholder="Paste your JSON here…"
				bind:value={inputJson}
			/>
			{#if errorMessage}
				<Alert.Root variant="destructive">
					<AlertCircleIcon />
					<Alert.Title>Unable to process your JSON</Alert.Title>
					<Alert.Description>{errorMessage}</Alert.Description>
				</Alert.Root>
			{:else if warningMessage}
				<Alert.Root>
					<AlertTriangleIcon />
					<Alert.Title>Malformed JSON was repaired</Alert.Title>
					<Alert.Description>{warningMessage}</Alert.Description>
				</Alert.Root>
			{/if}
		</div>
	</Resizable.Pane>
	<Resizable.Handle />
	<Resizable.Pane defaultSize={65}>
		<div bind:this={editorContainer} class="h-screen overflow-hidden"></div>
	</Resizable.Pane>
</Resizable.PaneGroup>