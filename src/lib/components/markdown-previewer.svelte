<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { marked } from "$lib/markdown";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import PaperclipIcon from "@lucide/svelte/icons/paperclip";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import { SIDEBAR_COOKIE_NAME } from "$lib/components/ui/sidebar/constants.js";
  	import AppSidebar from "$lib/components/app-sidebar.svelte";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn } from "$lib/utils";

	import {
		updateContent,
		saveAttachment,
		getAttachment,
		listAttachments,
		adoptAttachments,
		deleteAttachments,
		type FileNode,
	} from "$lib/files-db";
	import { fileTree } from "$lib/file-tree.svelte";
	import {
		MAX_ATTACHMENT_BYTES,
		SANITIZE_CONFIG,
		attachmentMarkdown,
		buildExportZip,
		extractAttachmentIds,
		resolveAttachmentUrls,
		type ResolvedAttachment,
	} from "$lib/attachments";

	// Idle time after which an in-progress edit is written to the active file
	// (IndexedDB).
	const SAVE_DEBOUNCE_MS = 1500;

	let markdownText = $state("");

	// Id of the file the editor is writing into. A local, non-reactive copy of
	// fileTree.activeFileId: it only serves to coordinate the writes to
	// IndexedDB, and has to stay the "old" one while switching to another file.
	let currentFileId: string | null = null;

	// Avoids saving when the text is set programmatically (opening a file)
	// rather than by a real user input.
	let suppressNextSave = false;

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	// Attachments saved before an active file existed (nodeId still null): they
	// are hooked up by adoptPendingAttachments as soon as the id is available.
	let pendingAttachmentIds: string[] = [];

	// Save state shown by the dot next to the file name. At startup it is
	// "saved": there is nothing waiting to be written.
	type SaveStatus = "saved" | "pending" | "saving" | "error";
	let saveStatus: SaveStatus = $state("saved");

	// Counter incremented on every user edit. It is captured before starting a
	// write to IndexedDB and compared again when the promise resolves: if a more
	// recent edit arrived in the meantime the result is stale and must not turn
	// the dot back to green.
	let saveGeneration = 0;

	const saveStatusClasses: Record<SaveStatus, string> = {
		saved: "bg-green-500",
		pending: "bg-red-500",
		saving: "bg-amber-500 animate-pulse",
		error: "bg-red-500",
	};
	const saveStatusLabels: Record<SaveStatus, string> = {
		saved: "Saved",
		pending: "Unsaved changes",
		saving: "Saving…",
		error: "Save failed",
	};
	const activeFileName = $derived(fileTree.activeFile?.name ?? "No file");
	let saveStatusClass = $derived(saveStatusClasses[saveStatus]);
	let saveStatusLabel = $derived(saveStatusLabels[saveStatus]);

	// Object URLs of the attachments referenced by the current text, by id.
	// Filled by the $effect below as the blobs are read from IndexedDB.
	let attachmentUrls: Record<string, ResolvedAttachment> = $state({});

	let rawHtml = $derived(marked.parse(markdownText) as string);
	let resolvedHtml = $derived(resolveAttachmentUrls(rawHtml, attachmentUrls));
	let htmlContent = $state("");

	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let previewEl: HTMLDivElement | null = $state(null);

	// Depth of the nested dragenter/dragleave events: without a counter the
	// overlay would disappear every time the cursor passes over a child of the
	// drop target.
	let dragDepth = $state(0);
	let isDraggingFiles = $derived(dragDepth > 0);

	// Below Tailwind's md breakpoint the two panes are stacked vertically
	// instead of side by side: on narrow screens two columns would both be
	// unusable.
	const NARROW_QUERY = "(max-width: 767px)";
	// Initialized synchronously during hydration so the horizontal layout
	// rendered on the server does not flicker on mobile.
	let isNarrow = $state(typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches);

	$effect(() => {
		const mediaQuery = window.matchMedia(NARROW_QUERY);
		isNarrow = mediaQuery.matches;
		const onChange = (event: MediaQueryListEvent) => {
			isNarrow = event.matches;
		};
		mediaQuery.addEventListener("change", onChange);
		return () => mediaQuery.removeEventListener("change", onChange);
	});

	/**
	 * Sidebar.Provider already writes the `sidebar_state` cookie on every open
	 * or close from desktop (see its `setOpen`), but nobody reads it back: the
	 * site is static, so the restore has to happen here on the client.
	 *
	 * Desktop only: below the breakpoint the sidebar is a slide-out panel
	 * governed by `openMobile`, which always starts closed; reopening it by
	 * itself on load would cover the editor.
	 */
	function readStoredSidebarOpen(): boolean {
		if (typeof document === "undefined") return true;
		if (window.matchMedia(NARROW_QUERY).matches) return true;
		const stored = document.cookie
			.split("; ")
			.find((entry) => entry.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
			?.slice(SIDEBAR_COOKIE_NAME.length + 1);
		return stored === undefined ? true : stored === "true";
	}

	// Read synchronously during hydration, like isNarrow: reading it from an
	// effect would make the sidebar flash into view before closing again.
	let sidebarOpen = $state(readStoredSidebarOpen());

	// Guard flag (plain variable, not reactive state) used to ignore the
	// "scroll" event fired by the browser when we programmatically set
	// scrollTop on the sync target, which would otherwise cause an infinite
	// ping-pong between the two panes.
	let isSyncingScroll = false;

	// Syncs scroll position by percentage (not raw pixels) so the two panes
	// stay aligned proportionally even though their width and content height
	// can differ.
	function syncScroll(source: HTMLElement, target: HTMLElement) {
		if (isSyncingScroll) return;
		isSyncingScroll = true;

		const sourceMaxScroll = source.scrollHeight - source.clientHeight;
		const ratio = sourceMaxScroll > 0 ? source.scrollTop / sourceMaxScroll : 0;

		const targetMaxScroll = target.scrollHeight - target.clientHeight;
		target.scrollTop = ratio * targetMaxScroll;

		requestAnimationFrame(() => {
			isSyncingScroll = false;
		});
	}

	$effect(() => {
		const textarea = textareaEl;
		const preview = previewEl;
		if (!textarea || !preview) return;

		const onTextareaScroll = () => syncScroll(textarea, preview);
		const onPreviewScroll = () => syncScroll(preview, textarea);

		textarea.addEventListener("scroll", onTextareaScroll);
		preview.addEventListener("scroll", onPreviewScroll);

		return () => {
			textarea.removeEventListener("scroll", onTextareaScroll);
			preview.removeEventListener("scroll", onPreviewScroll);
		};
	});

	$effect(() => {
		const html = resolvedHtml;
		if (typeof window !== "undefined") {
			import("dompurify").then((dompurify) => {
				htmlContent = dompurify.default.sanitize(html, SANITIZE_CONFIG);
			});
		}
	});

	/**
	 * Keeps `attachmentUrls` aligned with the references present in the text:
	 * loads the missing blobs from IndexedDB and revokes the object URLs of the
	 * attachments that are no longer mentioned. By depending only on
	 * markdownText it also covers restoring a document or a revision with no
	 * extra code.
	 */
	$effect(() => {
		const referenced = new Set(extractAttachmentIds(markdownText));
		let cancelled = false;

		// untrack: the effect reads and writes the same map it updates, so
		// without this it would invalidate itself forever. The only dependency
		// we care about is markdownText, already read above.
		untrack(() => {
			for (const [id, attachment] of Object.entries(attachmentUrls)) {
				if (referenced.has(id)) continue;
				URL.revokeObjectURL(attachment.url);
				delete attachmentUrls[id];
			}

			for (const id of referenced) {
				if (attachmentUrls[id]) continue;
				getAttachment(id)
					.then((attachment) => {
						// The text may have changed while we were reading: without
						// this check we would create an object URL nobody revokes.
						if (cancelled || !attachment || attachmentUrls[id]) return;
						attachmentUrls[id] = {
							url: URL.createObjectURL(attachment.blob),
							name: attachment.name,
						};
					})
					.catch((err) => {
						console.error(`Could not load attachment ${id}:`, err);
					});
			}
		});

		return () => {
			cancelled = true;
		};
	});

	// When the component is destroyed no object URL must be left dangling.
	$effect(() => {
		return () => {
			for (const attachment of Object.values(attachmentUrls)) {
				URL.revokeObjectURL(attachment.url);
			}
		};
	});

	// Pasting text is a normal edit of the open file; only files in the
	// clipboard need special treatment, because they have to be saved as
	// attachments instead of being inserted literally.
	function handlePaste(event: ClipboardEvent) {
		if (!textareaEl) return;
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		insertFiles(files);
	}

	function handleDragEnter(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) return;
		dragDepth++;
	}

	function handleDragOver(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) return;
		// Without preventDefault the browser refuses the drop and opens the file
		// on our behalf, leaving the page.
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	}

	function handleDragLeave(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function handleDrop(event: DragEvent) {
		dragDepth = 0;
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		textareaEl?.focus();
		insertFiles(files);
	}

	/**
	 * Saves the files as attachments and inserts their markdown references at
	 * the caret. The insertion goes through execCommand("insertText"): writing
	 * markdownText directly would wipe the textarea's undo stack, whereas this
	 * way the browser emits a real "input" event and both bind:value and the
	 * saving $effect behave as they do for ordinary typing.
	 */
	async function insertFiles(files: File[]) {
		const textarea = textareaEl;
		if (!textarea) return;

		const accepted = files.filter((file) => {
			if (file.size === 0) return false;
			if (file.size > MAX_ATTACHMENT_BYTES) {
				console.warn(`Attachment "${file.name}" skipped: exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
				return false;
			}
			return true;
		});
		if (accepted.length === 0) return;

		try {
			const snippets: string[] = [];
			for (const file of accepted) {
				const attachment = await saveAttachment(file, currentFileId);
				if (currentFileId === null) pendingAttachmentIds.push(attachment.id);
				snippets.push(attachmentMarkdown(attachment));
			}

			// The reference goes on a line of its own: appended to an already
			// occupied line it would be absorbed by whatever precedes it (an
			// unclosed code block, a list, a paragraph).
			const caret = textarea.selectionStart ?? textarea.value.length;
			const leadingNewline = caret > 0 && textarea.value[caret - 1] !== "\n" ? "\n" : "";
			const text = `${leadingNewline}${snippets.join("\n")}\n`;
			textarea.focus();
			// Some engines return true without inserting anything: compare the
			// value before/after instead of trusting the return value alone.
			const before = textarea.value;
			if (!document.execCommand("insertText", false, text) || textarea.value === before) {
				const start = textarea.selectionStart ?? textarea.value.length;
				const end = textarea.selectionEnd ?? textarea.value.length;
				textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
				textarea.setSelectionRange(start + text.length, start + text.length);
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			}
		} catch (err) {
			console.error("Could not attach files:", err);
			saveStatus = "error";
		}
	}

	/** Hooks up to the active file the attachments inserted before one existed. */
	function adoptPendingAttachments(nodeId: string) {
		if (pendingAttachmentIds.length === 0) return;
		const ids = pendingAttachmentIds;
		pendingAttachmentIds = [];
		adoptAttachments(ids, nodeId).catch((err) => {
			console.error("Could not link attachments to the file:", err);
		});
	}

	// Updates the dot only if no other edits arrived in the meantime: the
	// outcome of an already superseded write must not overwrite the state.
	function settleSaveStatus(generation: number, status: SaveStatus) {
		if (generation !== saveGeneration) return;
		saveStatus = status;
	}

	/**
	 * Deletes the attachments of a file that the just-saved text no longer
	 * mentions: with no reference they are unreachable by any means, keeping
	 * them would only make IndexedDB grow.
	 *
	 * Runs after the save and not in the $effect that resolves the object URLs:
	 * that effect also fires when another file is opened, and would delete the
	 * previous file's attachments.
	 */
	async function collectUnusedAttachments(nodeId: string, savedText: string) {
		const used = new Set(extractAttachmentIds(savedText));
		const stale = (await listAttachments(nodeId)).filter((attachment) => !used.has(attachment.id));
		if (stale.length > 0) {
			await deleteAttachments(stale.map((attachment) => attachment.id));
		}
	}

	function performPendingSave(nodeId: string | null, text: string) {
		// With no active file there is nowhere to write: this can only happen
		// after deleting the last file in the tree.
		if (!nodeId) {
			saveStatus = "saved";
			return;
		}
		const generation = saveGeneration;
		saveStatus = "saving";
		updateContent(nodeId, text)
			.then(() => {
				fileTree.syncContent(nodeId, text);
				settleSaveStatus(generation, "saved");
				return collectUnusedAttachments(nodeId, text);
			})
			.catch((err) => {
				console.error("Could not save the file:", err);
				settleSaveStatus(generation, "error");
			});
	}

	// Immediately saves any edit still waiting on the debounce (used on
	// beforeunload/pagehide and before opening another file).
	function flushPendingSave() {
		if (saveTimer === null) return;
		clearTimeout(saveTimer);
		saveTimer = null;
		performPendingSave(currentFileId, markdownText);
	}

	$effect(() => {
		const text = markdownText;

		if (suppressNextSave) {
			suppressNextSave = false;
			return;
		}

		if (saveTimer !== null) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}

		// From here on there is a user edit not yet persisted: the dot turns red
		// and every older in-flight write is invalidated.
		saveGeneration++;
		saveStatus = "pending";

		// currentFileId is read when the debounce expires, not now: an edit
		// started before the tree had finished loading must still end up in the
		// file that was opened in the meantime.
		saveTimer = setTimeout(() => {
			saveTimer = null;
			performPendingSave(currentFileId, text);
		}, SAVE_DEBOUNCE_MS);
	});

	/**
	 * Opens a file in the editor. Pending edits on the previous file are written
	 * before changing `currentFileId`, otherwise they would end up in the
	 * just-opened file. The loaded text is by definition already persisted, so
	 * the saving $effect has to be silenced (suppressNextSave) and the dot stays
	 * green.
	 */
	function openFile(node: FileNode | null) {
		// The first file comes from init(), which is async: if the user has
		// already typed something in the meantime we do not throw it away, their
		// text becomes the content of the file just opened.
		const keepUserText = node !== null && currentFileId === null && markdownText !== "";

		// With keepUserText the running debounce must not be forced: it will fire
		// on its own and at that point write into the newly attached file.
		if (!keepUserText && node?.id !== currentFileId) flushPendingSave();
		currentFileId = node?.id ?? null;
		if (node) adoptPendingAttachments(node.id);
		if (keepUserText) return;

		const content = node?.content ?? "";
		// If the content already matches what is shown the $effect does not run
		// again: raising the flag would leave it pending and would end up
		// suppressing the save of the user's first real edit.
		if (content !== markdownText) {
			suppressNextSave = true;
			markdownText = content;
		}
		saveStatus = "saved";
	}

	onMount(() => {
		// Loads the tree and reopens the last file being worked on, so reloading
		// the page does not lose the context. On the very first open the tree is
		// empty and init() creates the sample file.
		fileTree.setOpenFileHandler(openFile);
		fileTree.init().catch((err) => {
			console.error("Could not load the file tree:", err);
			saveStatus = "error";
		});

		// A file dropped outside the drop zone would make the browser navigate to
		// the file itself, throwing away the open document: here the drop is
		// neutralized everywhere except where we handle it ourselves.
		// This only concerns files dragged in from outside: a drag internal to
		// the file tree has to be able to stay "not accepted" where the drop is
		// illegal, otherwise the browser would show the release cursor anyway.
		const swallowStrayDrop = (event: DragEvent) => {
			if (event.defaultPrevented) return;
			if (!event.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			if (event.type === "drop") dragDepth = 0;
		};
		window.addEventListener("dragover", swallowStrayDrop);
		window.addEventListener("drop", swallowStrayDrop);

		window.addEventListener("beforeunload", flushPendingSave);
		window.addEventListener("pagehide", flushPendingSave);
		return () => {
			window.removeEventListener("dragover", swallowStrayDrop);
			window.removeEventListener("drop", swallowStrayDrop);
			window.removeEventListener("beforeunload", flushPendingSave);
			window.removeEventListener("pagehide", flushPendingSave);
		};
	});

	function downloadPdf() {
		window.print();
	}

	function triggerDownload(blob: Blob, fileName: string) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = fileName;
		link.click();
		URL.revokeObjectURL(url);
	}

	/**
	 * Tree nodes have no extension: it is the export that adds ".md", unless the
	 * user already put it in the name by hand.
	 */
	function exportBaseName(): string {
		return fileTree.activeFile?.name.trim() || "document";
	}

	function markdownFileName(): string {
		const base = exportBaseName();
		return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
	}

	/**
	 * With no attachments only the .md is downloaded, as always. With
	 * attachments a zip is needed: the "attachment:<id>" references mean nothing
	 * outside the app, so they are rewritten into paths relative to the
	 * "attachments/" folder.
	 */
	async function downloadMarkdown() {
		try {
			const attachments = currentFileId ? await listAttachments(currentFileId) : [];
			const used = new Set(extractAttachmentIds(markdownText));
			const referenced = attachments.filter((attachment) => used.has(attachment.id));
			if (referenced.length === 0) {
				triggerDownload(
					new Blob([markdownText], { type: "text/markdown;charset=utf-8" }),
					markdownFileName(),
				);
				return;
			}
			triggerDownload(
				await buildExportZip(markdownText, referenced, markdownFileName()),
				`${exportBaseName()}.zip`,
			);
		} catch (err) {
			console.error("Could not export the document:", err);
		}
	}
</script>

<ModeWatcher />


<!-- h-svh (not h-screen/100vh): the "small" viewport height treats the mobile
     browser bars as visible, so the toolbar at the bottom is never covered
     when they appear.
     This is the node that pins the height: without the cap here the sidebar
     wrapper is only `min-h-svh`, the whole page scrolls and the two panes stop
     being scroll containers (no `scroll` event, no sync). -->
<Sidebar.Provider
  bind:open={sidebarOpen}
  class="h-svh overflow-hidden print:h-auto print:overflow-visible"
>
  <AppSidebar />
  <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden print:min-h-0 print:overflow-visible">
		<div class="flex min-h-0 flex-1 flex-col print:h-auto print:min-h-0">
			<div class="min-h-0 flex-1 print:hidden">
				<Resizable.PaneGroup
					direction={isNarrow ? "vertical" : "horizontal"}
					autoSaveId={isNarrow ? "markdown-previewer-layout-vertical" : "markdown-previewer-layout"}
				>
					<Resizable.Pane defaultSize={50} minSize={20}>
						<div class="flex h-full min-h-0 flex-col gap-2 p-2 sm:gap-4 sm:p-4">
							<div class="flex flex-wrap gap-2 items-center justify-between">
								<div class="flex flex-wrap gap-2 items-center">
									<Sidebar.Trigger />

									<small
										class="text-sm leading-none font-medium"
										data-testid="active-file-name">{activeFileName}</small
									>
									<div
										class={cn(
											"size-3 rounded-full",
											saveStatusClass,
										)}
										title={saveStatusLabel}
									></div>
								</div>
								<div class="flex flex-wrap gap-2 items-center">
									<Button
										size="sm"
										variant="outline"
										aria-label="Download Markdown"
										onclick={downloadMarkdown}
									>
										<DownloadIcon />
										.md
									</Button>
									<Button size="sm" aria-label="Download PDF" onclick={downloadPdf}>
										<DownloadIcon />
										.pdf
									</Button>
								</div>
							</div>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="relative flex min-h-0 flex-1 flex-col"
								data-testid="editor-drop-zone"
								ondragenter={handleDragEnter}
								ondragover={handleDragOver}
								ondragleave={handleDragLeave}
								ondrop={handleDrop}
							>
								<Textarea
									id="markdown-input"
									class="min-h-0 flex-1 resize-none overflow-y-auto font-mono p-4 leading-relaxed field-sizing-fixed"
									placeholder="Type your markdown here..."
									bind:value={markdownText}
									bind:ref={textareaEl}
									onpaste={handlePaste}
								/>
								{#if isDraggingFiles}
									<div
										class="bg-background/80 border-primary text-primary pointer-events-none absolute inset-0 flex items-center justify-center gap-2 rounded-md border-2 border-dashed text-sm font-medium"
										data-testid="drop-overlay"
									>
										<PaperclipIcon class="size-4" />
										Drop to attach
									</div>
								{/if}
							</div>
						</div>
					</Resizable.Pane>
					<Resizable.Handle />
					<Resizable.Pane defaultSize={50} minSize={20}>
						<div id="preview-pane" class="h-full overflow-y-auto p-4 sm:p-8" bind:this={previewEl}>
							<article class="markdown-body">
								{@html htmlContent}
							</article>
						</div>
					</Resizable.Pane>
				</Resizable.PaneGroup>
			</div>

			<!-- Print-only rendition: bypasses the resizable split view so the exported
				PDF contains the full, unclipped markdown output instead of a fixed-size pane.
				Uses a <div> rather than <article> so it stays out of the way of the
				single semantic <article> the app exposes to assistive tech and tests. -->
			<div class="markdown-body hidden print:block">
				{@html htmlContent}
			</div>
		</div>

  </main>
</Sidebar.Provider>
