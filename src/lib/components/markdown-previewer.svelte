<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { mode, ModeWatcher } from "mode-watcher";
	import { marked } from "$lib/markdown";
	import DownloadIcon from "@lucide/svelte/icons/download";
	import HistoryIcon from "@lucide/svelte/icons/history";
	import PaperclipIcon from "@lucide/svelte/icons/paperclip";
	import * as Resizable from "$lib/components/ui/resizable/index.js";
	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  	import AppSidebar from "$lib/components/app-sidebar.svelte";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { cn } from "$lib/utils";

	import {
		createDocument,
		addRevision,
		getDocument,
		getLatestDocument,
		listRevisions,
		saveAttachment,
		getAttachment,
		listAttachments,
		adoptAttachments,
		type ChangeType,
	} from "$lib/history-db";
	import {
		MAX_ATTACHMENT_BYTES,
		SANITIZE_CONFIG,
		attachmentMarkdown,
		buildExportZip,
		extractAttachmentIds,
		resolveAttachmentUrls,
		type ResolvedAttachment,
	} from "$lib/attachments";

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

	// Allegati salvati prima che il documento esistesse (documentId ancora null):
	// vengono agganciati da setCurrentDocumentId appena l'id è disponibile.
	let pendingAttachmentIds: string[] = [];

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

	// Object URL degli allegati referenziati dal testo corrente, per id. Popolata
	// dall'$effect qui sotto man mano che i blob vengono letti da IndexedDB.
	let attachmentUrls: Record<string, ResolvedAttachment> = $state({});

	let rawHtml = $derived(marked.parse(markdownText) as string);
	let resolvedHtml = $derived(resolveAttachmentUrls(rawHtml, attachmentUrls));
	let htmlContent = $state("");

	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let previewEl: HTMLDivElement | null = $state(null);

	// Profondità dei dragenter/dragleave annidati: senza contatore l'overlay
	// sparirebbe ogni volta che il cursore passa sopra un figlio del drop target.
	let dragDepth = $state(0);
	let isDraggingFiles = $derived(dragDepth > 0);

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
		const html = resolvedHtml;
		if (typeof window !== "undefined") {
			import("dompurify").then((dompurify) => {
				htmlContent = dompurify.default.sanitize(html, SANITIZE_CONFIG);
			});
		}
	});

	/**
	 * Mantiene allineata `attachmentUrls` ai riferimenti presenti nel testo:
	 * carica da IndexedDB i blob mancanti e revoca gli object URL degli allegati
	 * che non sono più citati. Dipendendo solo da markdownText copre senza codice
	 * aggiuntivo anche il ripristino di un documento o di una revisione.
	 */
	$effect(() => {
		const referenced = new Set(extractAttachmentIds(markdownText));
		let cancelled = false;

		// untrack: l'effect legge e scrive la stessa mappa che aggiorna, quindi
		// senza questo si auto-invaliderebbe all'infinito. L'unica dipendenza
		// che ci interessa è markdownText, già letta qui sopra.
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
						// Il testo può essere cambiato mentre leggevamo: senza questo
						// controllo si creerebbe un object URL che nessuno revocherà.
						if (cancelled || !attachment || attachmentUrls[id]) return;
						attachmentUrls[id] = {
							url: URL.createObjectURL(attachment.blob),
							name: attachment.name,
						};
					})
					.catch((err) => {
						console.error(`Impossibile caricare l'allegato ${id}:`, err);
					});
			}
		});

		return () => {
			cancelled = true;
		};
	});

	// Alla distruzione del componente nessun object URL deve restare appeso.
	$effect(() => {
		return () => {
			for (const attachment of Object.values(attachmentUrls)) {
				URL.revokeObjectURL(attachment.url);
			}
		};
	});

	// Rileva se un evento "paste" sta sostituendo (quasi) interamente il
	// contenuto corrente: in tal caso lo trattiamo come l'inserimento di un
	// documento diverso (nuova entry in cronologia) invece che come una
	// modifica del documento su cui si stava già lavorando. La lettura di
	// selectionStart/selectionEnd/value avviene sincronicamente nell'handler,
	// prima che il browser applichi il testo incollato.
	function handlePaste(event: ClipboardEvent) {
		const textarea = textareaEl;
		if (!textarea) return;

		// Incollare un file è sempre un inserimento dentro il documento corrente,
		// mai la sostituzione con un documento diverso: si esce prima
		// dell'euristica sul full replace.
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length > 0) {
			event.preventDefault();
			insertFiles(files);
			return;
		}

		const { selectionStart, selectionEnd, value } = textarea;
		const selectedLength = selectionEnd - selectionStart;
		const isFullReplace = value.length === 0 || selectedLength / Math.max(value.length, 1) > 0.8;
		if (isFullReplace) {
			pendingPasteIsNewDocument = true;
		} else {
			pendingPasteIsPartial = true;
		}
	}

	function handleDragEnter(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) return;
		dragDepth++;
	}

	function handleDragOver(event: DragEvent) {
		if (!event.dataTransfer?.types.includes("Files")) return;
		// Senza preventDefault il browser rifiuta il drop e apre il file al posto
		// nostro, abbandonando la pagina.
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
	 * Salva i file come allegati e ne inserisce i riferimenti markdown al punto
	 * del cursore. L'inserimento passa da execCommand("insertText"): scrivere
	 * direttamente markdownText azzererebbe lo stack di undo della textarea,
	 * mentre così il browser emette un vero evento "input" e sia bind:value sia
	 * l'$effect di salvataggio si comportano come per una normale digitazione.
	 */
	async function insertFiles(files: File[]) {
		const textarea = textareaEl;
		if (!textarea) return;

		const accepted = files.filter((file) => {
			if (file.size === 0) return false;
			if (file.size > MAX_ATTACHMENT_BYTES) {
				console.warn(`Allegato "${file.name}" ignorato: supera i ${MAX_ATTACHMENT_BYTES} byte.`);
				return false;
			}
			return true;
		});
		if (accepted.length === 0) return;

		try {
			const snippets: string[] = [];
			for (const file of accepted) {
				const attachment = await saveAttachment(file, currentDocumentId);
				if (currentDocumentId === null) pendingAttachmentIds.push(attachment.id);
				snippets.push(attachmentMarkdown(attachment));
			}

			// La revisione risultante va marcata come "paste", non come "edit".
			pendingPasteIsPartial = true;

			// Il riferimento va su una riga propria: inserito in coda a una riga già
			// occupata verrebbe assorbito da ciò che la precede (un blocco di codice
			// non chiuso, una lista, un paragrafo).
			const caret = textarea.selectionStart ?? textarea.value.length;
			const leadingNewline = caret > 0 && textarea.value[caret - 1] !== "\n" ? "\n" : "";
			const text = `${leadingNewline}${snippets.join("\n")}\n`;
			textarea.focus();
			// Alcuni motori ritornano true senza inserire nulla: si confronta il
			// valore prima/dopo invece di fidarsi del solo valore di ritorno.
			const before = textarea.value;
			if (!document.execCommand("insertText", false, text) || textarea.value === before) {
				const start = textarea.selectionStart ?? textarea.value.length;
				const end = textarea.selectionEnd ?? textarea.value.length;
				textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
				textarea.setSelectionRange(start + text.length, start + text.length);
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			}
		} catch (err) {
			console.error("Impossibile allegare i file:", err);
			saveStatus = "error";
		}
	}

	/**
	 * Aggancia l'editor a un documento, adottando gli allegati inseriti prima
	 * che il documento esistesse.
	 */
	function setCurrentDocumentId(documentId: string) {
		currentDocumentId = documentId;
		if (pendingAttachmentIds.length === 0) return;
		const ids = pendingAttachmentIds;
		pendingAttachmentIds = [];
		adoptAttachments(ids, documentId).catch((err) => {
			console.error("Impossibile associare gli allegati al documento:", err);
		});
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
					setCurrentDocumentId(id);
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
					setCurrentDocumentId(id);
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

	/**
	 * Applica alla textarea un contenuto proveniente dalla cronologia,
	 * agganciando l'editor al relativo documento. Il testo restaurato è per
	 * definizione già persistito, quindi l'$effect di salvataggio va zittito
	 * (suppressNextSave) e il pallino resta verde.
	 */
	function applyRestoredDocument(documentId: string, content: string) {
		// Se il contenuto coincide già con quello mostrato l'$effect non viene
		// rieseguito: alzare il flag lo lascerebbe pendente e finirebbe per
		// sopprimere il salvataggio della prima vera modifica dell'utente.
		if (content !== markdownText) {
			suppressNextSave = true;
			markdownText = content;
		}
		setCurrentDocumentId(documentId);
		saveStatus = "saved";
	}

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		const docId = params.get("doc");
		if (!docId) {
			// Nessun documento richiesto esplicitamente: si riprende l'ultimo su
			// cui si stava lavorando, così ricaricando la pagina non si perde il
			// contesto. Il testo di default resta solo alla primissima apertura,
			// quando la cronologia è ancora vuota.
			getLatestDocument()
				.then((latest) => {
					// Se nel frattempo l'utente ha già iniziato a scrivere (o incollato
					// qualcosa, creando un documento) non sovrascriviamo il suo lavoro.
					if (!latest || currentDocumentId || markdownText !== initialMarkdownText) return;
					applyRestoredDocument(latest.id, latest.latestContent);
				})
				.catch((err) => {
					console.error("Impossibile caricare l'ultimo documento dalla cronologia:", err);
				});
		} else {
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
						applyRestoredDocument(docId, content);
					}
				})
				.catch((err) => {
					console.error("Impossibile caricare il documento dalla cronologia:", err);
				});
			window.history.replaceState(null, "", window.location.pathname);
		}

		// Un file rilasciato fuori dalla drop zone farebbe navigare il browser sul
		// file stesso, buttando via il documento aperto: qui il drop viene
		// neutralizzato ovunque tranne che dove lo gestiamo noi.
		const swallowStrayDrop = (event: DragEvent) => {
			if (event.defaultPrevented) return;
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
	 * Senza allegati si scarica il solo .md, come sempre. Con allegati serve uno
	 * zip: i riferimenti "attachment:<id>" non significano nulla fuori dall'app,
	 * quindi vengono riscritti in percorsi relativi alla cartella "attachments/".
	 */
	async function downloadMarkdown() {
		try {
			const attachments = currentDocumentId ? await listAttachments(currentDocumentId) : [];
			const used = new Set(extractAttachmentIds(markdownText));
			const referenced = attachments.filter((attachment) => used.has(attachment.id));
			if (referenced.length === 0) {
				triggerDownload(
					new Blob([markdownText], { type: "text/markdown;charset=utf-8" }),
					"document.md",
				);
				return;
			}
			triggerDownload(await buildExportZip(markdownText, referenced), "document.zip");
		} catch (err) {
			console.error("Impossibile esportare il documento:", err);
		}
	}
</script>

<ModeWatcher />


<Sidebar.Provider>
  <AppSidebar />
  <main class="flex flex-1 flex-col overflow-hidden">
	<!-- h-svh (non h-screen/100vh): l'altezza "small" del viewport considera le
     barre del browser mobile come visibili, così la toolbar in fondo non
     finisce mai coperta quando compaiono. -->
		<div class="flex h-svh flex-col print:h-auto flex-1">
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

									<!-- editable file name -->
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<div class="">
										<small class="text-sm leading-none font-medium">Document name</small>
									</div>
									<div
										class={cn(
											"size-3 rounded-full",
											saveStatusClass,
										)}
										title={saveStatusLabel}
									></div>
								</div>
								<div class="flex flex-wrap gap-2 items-center">
									<Button size="sm" variant="outline" onclick={downloadMarkdown}>
										<DownloadIcon />
										.md
									</Button>
									<Button size="sm" onclick={downloadPdf}>
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
									class="flex-1 resize-none font-mono p-4 leading-relaxed"
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
										Rilascia per allegare
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