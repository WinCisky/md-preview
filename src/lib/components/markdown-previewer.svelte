<script lang="ts">
	import { onMount } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { marked } from "$lib/markdown";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import HistoryIcon from "@lucide/svelte/icons/history";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { createDocument, addRevision, getDocument, listRevisions, type ChangeType } from "$lib/history-db";

	const base = import.meta.env.BASE_URL;

	// Tempo di inattività dopo il quale una modifica in corso viene salvata
	// come revisione nella cronologia locale (IndexedDB).
	const SAVE_DEBOUNCE_MS = 1500;

	const initialMarkdownText = "# Hello Markdown\n\nType something on the left to see the preview on the right!\n\n- **Bold** text\n- *Italic* text\n- [A link](https://google.com)\n\n```javascript\nconsole.log('Hello World');\n```";
	let markdownText = $state(initialMarkdownText);

	// Id del documento correntemente "attivo" nella cronologia (null finché
	// non è ancora stato salvato nulla). Variabile semplice, non reattiva:
	// serve solo a coordinare le chiamate a history-db.ts.
	let currentDocumentId: string | null = null;

	// Coordinamento tra l'handler di paste e l'$effect che osserva markdownText:
	// - suppressNextSave evita di salvare quando il testo viene impostato in modo
	//   programmatico (es. ripristino da cronologia) invece che da un vero input utente.
	// - pendingPasteIsNewDocument / pendingPasteIsPartial registrano cosa è successo
	//   nell'ultimo evento "paste" prima che l'effect reagisca al cambio di testo.
	let suppressNextSave = false;
	let pendingPasteIsNewDocument = false;
	let pendingPasteIsPartial = false;

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingSaveChangeType: ChangeType = "edit";

	let rawHtml = $derived(marked.parse(markdownText) as string);
	let htmlContent = $state("");

	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let previewEl: HTMLDivElement | null = $state(null);

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
		const html = rawHtml;
		if (typeof window !== "undefined") {
			import("dompurify").then((dompurify) => {
				htmlContent = dompurify.default.sanitize(html);
			});
		}
	});

	// Rileva se un evento "paste" sta sostituendo (quasi) interamente il
	// contenuto corrente: in tal caso lo trattiamo come l'inserimento di un
	// documento diverso (nuova entry in cronologia) invece che come una
	// modifica del documento su cui si stava già lavorando. La lettura di
	// selectionStart/selectionEnd/value avviene sincronicamente nell'handler,
	// prima che il browser applichi il testo incollato.
	function handlePaste() {
		const textarea = textareaEl;
		if (!textarea) return;
		const { selectionStart, selectionEnd, value } = textarea;
		const selectedLength = selectionEnd - selectionStart;
		const isFullReplace = value.length === 0 || selectedLength / Math.max(value.length, 1) > 0.8;
		if (isFullReplace) {
			pendingPasteIsNewDocument = true;
		} else {
			pendingPasteIsPartial = true;
		}
	}

	function performPendingSave(text: string, changeType: ChangeType) {
		if (currentDocumentId) {
			addRevision(currentDocumentId, text, changeType).catch((err) => {
				console.error("Impossibile salvare la revisione nella cronologia:", err);
			});
		} else {
			createDocument(text, "typed")
				.then((id) => {
					currentDocumentId = id;
				})
				.catch((err) => {
					console.error("Impossibile creare il documento nella cronologia:", err);
				});
		}
	}

	// Salva immediatamente un'eventuale modifica ancora in attesa del debounce
	// (usato su beforeunload/pagehide per non perdere l'ultima modifica).
	function flushPendingSave() {
		if (saveTimer === null) return;
		clearTimeout(saveTimer);
		saveTimer = null;
		performPendingSave(markdownText, pendingSaveChangeType);
	}

	$effect(() => {
		const text = markdownText;

		if (suppressNextSave) {
			suppressNextSave = false;
			return;
		}
		// Non salvare finché il testo è ancora quello di default e non è mai
		// stato creato alcun documento: evita di sporcare la cronologia ad ogni
		// avvio dell'app quando l'utente non ha ancora scritto/incollato nulla.
		if (text === initialMarkdownText && !currentDocumentId) {
			return;
		}

		if (saveTimer !== null) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}

		if (pendingPasteIsNewDocument) {
			pendingPasteIsNewDocument = false;
			pendingPasteIsPartial = false;
			currentDocumentId = null;
			createDocument(text, "pasted")
				.then((id) => {
					currentDocumentId = id;
				})
				.catch((err) => {
					console.error("Impossibile creare il documento nella cronologia:", err);
				});
			return;
		}

		pendingSaveChangeType = pendingPasteIsPartial ? "paste" : "edit";
		pendingPasteIsPartial = false;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			performPendingSave(text, pendingSaveChangeType);
		}, SAVE_DEBOUNCE_MS);
	});

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		const docId = params.get("doc");
		if (docId) {
			suppressNextSave = true;
			const revId = params.get("rev");
			// Se è richiesta una revisione specifica ne carichiamo il contenuto,
			// ma restiamo comunque agganciati allo stesso documentId: le
			// modifiche successive continueranno quel documento.
			const loadContent = revId
				? listRevisions(docId).then((revisions) => {
						const match = revisions.find((revision) => String(revision.id) === revId);
						return match ? match.content : null;
					})
				: getDocument(docId).then((doc) => doc?.latestContent ?? null);

			loadContent
				.then((content) => {
					if (content !== null) {
						markdownText = content;
						currentDocumentId = docId;
					} else {
						suppressNextSave = false;
					}
				})
				.catch((err) => {
					console.error("Impossibile caricare il documento dalla cronologia:", err);
					suppressNextSave = false;
				});
			window.history.replaceState(null, "", window.location.pathname);
		}

		window.addEventListener("beforeunload", flushPendingSave);
		window.addEventListener("pagehide", flushPendingSave);
		return () => {
			window.removeEventListener("beforeunload", flushPendingSave);
			window.removeEventListener("pagehide", flushPendingSave);
		};
	});

	function downloadPdf() {
		window.print();
	}

	function downloadMarkdown() {
		const blob = new Blob([markdownText], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "document.md";
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

<ModeWatcher />

<div class="flex h-screen flex-col">
	<div class="min-h-0 flex-1 print:hidden">
		<Resizable.PaneGroup direction="horizontal" autoSaveId="markdown-previewer-layout">
			<Resizable.Pane defaultSize={50}>
				<div class="flex h-full flex-col gap-2 p-4">
					<Textarea
						id="markdown-input"
						class="flex-1 resize-none font-mono p-4 leading-relaxed"
						placeholder="Type your markdown here..."
						bind:value={markdownText}
						bind:ref={textareaEl}
						onpaste={handlePaste}
					/>
					<div class="flex gap-2">
						<Button size="sm" variant="outline" onclick={downloadMarkdown}>
							<DownloadIcon />
							Download Markdown
						</Button>
						<Button size="sm" onclick={downloadPdf}>
							<DownloadIcon />
							Download PDF
						</Button>
						<Button size="sm" variant="outline" href={`${base}history`}>
							<HistoryIcon />
							Cronologia
						</Button>
					</div>
				</div>
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane defaultSize={50}>
				<div id="preview-pane" class="h-full overflow-y-auto p-8" bind:this={previewEl}>
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
