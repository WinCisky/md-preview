<script lang="ts">
	import { onMount } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { marked } from "$lib/markdown";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import HistoryIcon from "@lucide/svelte/icons/history";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn } from "$lib/utils";
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

	// Stato del salvataggio mostrato dal pallino dentro il pulsante "Cronologia".
	// All'avvio è "saved": non c'è nulla in attesa di essere scritto.
	type SaveStatus = "saved" | "pending" | "saving" | "error";
	let saveStatus: SaveStatus = $state("saved");

	// Contatore incrementato ad ogni modifica dell'utente. Viene catturato prima
	// di avviare una scrittura su IndexedDB e riconfrontato quando la promise si
	// risolve: se nel frattempo è arrivata una modifica più recente il risultato
	// è obsoleto e non deve riportare il pallino a verde.
	let saveGeneration = 0;

	const saveStatusClasses: Record<SaveStatus, string> = {
		saved: "bg-green-500",
		pending: "bg-red-500",
		saving: "bg-amber-500 animate-pulse",
		error: "bg-red-500",
	};
	const saveStatusLabels: Record<SaveStatus, string> = {
		saved: "Salvato",
		pending: "Modifiche non salvate",
		saving: "Salvataggio in corso…",
		error: "Salvataggio non riuscito",
	};
	let saveStatusClass = $derived(saveStatusClasses[saveStatus]);
	let saveStatusLabel = $derived(saveStatusLabels[saveStatus]);

	let rawHtml = $derived(marked.parse(markdownText) as string);
	let htmlContent = $state("");

	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let previewEl: HTMLDivElement | null = $state(null);

	// Sotto il breakpoint md di Tailwind i due pannelli vengono impilati
	// verticalmente invece che affiancati: su schermi stretti due colonne
	// sarebbero entrambe inutilizzabili.
	const NARROW_QUERY = "(max-width: 767px)";
	// Inizializzato in modo sincrono durante l'hydration così il layout
	// orizzontale renderizzato lato server non "sfarfalla" su mobile.
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

	// Aggiorna il pallino solo se nel frattempo non sono arrivate altre modifiche:
	// l'esito di una scrittura ormai superata non deve sovrascrivere lo stato.
	function settleSaveStatus(generation: number, status: SaveStatus) {
		if (generation !== saveGeneration) return;
		saveStatus = status;
	}

	function performPendingSave(text: string, changeType: ChangeType) {
		const generation = saveGeneration;
		saveStatus = "saving";
		if (currentDocumentId) {
			addRevision(currentDocumentId, text, changeType)
				.then(() => {
					settleSaveStatus(generation, "saved");
				})
				.catch((err) => {
					console.error("Impossibile salvare la revisione nella cronologia:", err);
					settleSaveStatus(generation, "error");
				});
		} else {
			createDocument(text, "typed")
				.then((id) => {
					currentDocumentId = id;
					settleSaveStatus(generation, "saved");
				})
				.catch((err) => {
					console.error("Impossibile creare il documento nella cronologia:", err);
					settleSaveStatus(generation, "error");
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

		// Da qui in poi c'è una modifica utente non ancora persistita: il pallino
		// diventa rosso e ogni scrittura in volo più vecchia viene invalidata.
		saveGeneration++;
		saveStatus = "pending";

		if (pendingPasteIsNewDocument) {
			pendingPasteIsNewDocument = false;
			pendingPasteIsPartial = false;
			currentDocumentId = null;
			const generation = saveGeneration;
			saveStatus = "saving";
			createDocument(text, "pasted")
				.then((id) => {
					currentDocumentId = id;
					settleSaveStatus(generation, "saved");
				})
				.catch((err) => {
					console.error("Impossibile creare il documento nella cronologia:", err);
					settleSaveStatus(generation, "error");
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
						// Il contenuto ripristinato è per definizione già in cronologia.
						saveStatus = "saved";
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

<!-- h-svh (non h-screen/100vh): l'altezza "small" del viewport considera le
     barre del browser mobile come visibili, così la toolbar in fondo non
     finisce mai coperta quando compaiono. -->
<div class="flex h-svh flex-col print:h-auto">
	<div class="min-h-0 flex-1 print:hidden">
		<Resizable.PaneGroup
			direction={isNarrow ? "vertical" : "horizontal"}
			autoSaveId={isNarrow ? "markdown-previewer-layout-vertical" : "markdown-previewer-layout"}
		>
			<Resizable.Pane defaultSize={50} minSize={20}>
				<div class="flex h-full min-h-0 flex-col gap-2 p-2 sm:p-4">
					<Textarea
						id="markdown-input"
						class="flex-1 resize-none font-mono p-4 leading-relaxed"
						placeholder="Type your markdown here..."
						bind:value={markdownText}
						bind:ref={textareaEl}
						onpaste={handlePaste}
					/>
					<div class="flex flex-wrap gap-2">
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
							<span
								class={cn("size-2 shrink-0 rounded-full", saveStatusClass)}
								data-testid="save-status"
								data-status={saveStatus}
								title={saveStatusLabel}
								aria-label={saveStatusLabel}
								role="status"
							></span>
						</Button>
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
