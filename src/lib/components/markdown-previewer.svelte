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

	// Tempo di inattività dopo il quale una modifica in corso viene scritta
	// sul file attivo (IndexedDB).
	const SAVE_DEBOUNCE_MS = 1500;

	let markdownText = $state("");

	// Id del file su cui l'editor sta scrivendo. Copia locale e non reattiva di
	// fileTree.activeFileId: serve solo a coordinare le scritture su IndexedDB,
	// e deve restare quella "vecchia" mentre si passa a un altro file.
	let currentFileId: string | null = null;

	// Evita di salvare quando il testo viene impostato in modo programmatico
	// (apertura di un file) invece che da un vero input utente.
	let suppressNextSave = false;

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	// Allegati salvati prima che esistesse un file attivo (nodeId ancora null):
	// vengono agganciati da adoptPendingAttachments appena l'id è disponibile.
	let pendingAttachmentIds: string[] = [];

	// Stato del salvataggio mostrato dal pallino accanto al nome del file.
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
	const activeFileName = $derived(fileTree.activeFile?.name ?? "Nessun file");
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

	/**
	 * Sidebar.Provider scrive già il cookie `sidebar_state` ad ogni apertura o
	 * chiusura da desktop (vedi il suo `setOpen`), ma nessuno lo rilegge: il sito
	 * è statico, quindi il ripristino va fatto qui lato client.
	 *
	 * Solo desktop: sotto il breakpoint la sidebar è un pannello a scomparsa
	 * governato da `openMobile`, che parte sempre chiuso; riaprirlo da solo al
	 * caricamento coprirebbe l'editor.
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

	// Letto in modo sincrono durante l'hydration, come isNarrow: leggerlo da un
	// effect farebbe comparire la sidebar per un istante prima di richiuderla.
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

	// Incollare del testo è una normale modifica del file aperto; solo i file
	// negli appunti richiedono un trattamento a parte, perché vanno salvati
	// come allegati invece che inseriti alla lettera.
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
				const attachment = await saveAttachment(file, currentFileId);
				if (currentFileId === null) pendingAttachmentIds.push(attachment.id);
				snippets.push(attachmentMarkdown(attachment));
			}

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

	/** Aggancia al file attivo gli allegati inseriti prima che ne esistesse uno. */
	function adoptPendingAttachments(nodeId: string) {
		if (pendingAttachmentIds.length === 0) return;
		const ids = pendingAttachmentIds;
		pendingAttachmentIds = [];
		adoptAttachments(ids, nodeId).catch((err) => {
			console.error("Impossibile associare gli allegati al file:", err);
		});
	}

	// Aggiorna il pallino solo se nel frattempo non sono arrivate altre modifiche:
	// l'esito di una scrittura ormai superata non deve sovrascrivere lo stato.
	function settleSaveStatus(generation: number, status: SaveStatus) {
		if (generation !== saveGeneration) return;
		saveStatus = status;
	}

	/**
	 * Cancella gli allegati di un file che il testo appena salvato non cita più:
	 * senza riferimento non sono raggiungibili in alcun modo, tenerli farebbe
	 * solo crescere IndexedDB.
	 *
	 * Gira dopo il salvataggio e non nell'$effect che risolve gli object URL:
	 * quell'effect scatta anche quando si apre un altro file, e cancellerebbe
	 * gli allegati del file precedente.
	 */
	async function collectUnusedAttachments(nodeId: string, savedText: string) {
		const used = new Set(extractAttachmentIds(savedText));
		const stale = (await listAttachments(nodeId)).filter((attachment) => !used.has(attachment.id));
		if (stale.length > 0) {
			await deleteAttachments(stale.map((attachment) => attachment.id));
		}
	}

	function performPendingSave(nodeId: string | null, text: string) {
		// Senza file attivo non c'è dove scrivere: può succedere solo dopo aver
		// eliminato l'ultimo file dell'albero.
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
				console.error("Impossibile salvare il file:", err);
				settleSaveStatus(generation, "error");
			});
	}

	// Salva immediatamente un'eventuale modifica ancora in attesa del debounce
	// (usato su beforeunload/pagehide e prima di aprire un altro file).
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

		// Da qui in poi c'è una modifica utente non ancora persistita: il pallino
		// diventa rosso e ogni scrittura in volo più vecchia viene invalidata.
		saveGeneration++;
		saveStatus = "pending";

		// currentFileId viene letto allo scadere del debounce, non adesso: una
		// modifica iniziata prima che l'albero avesse finito di caricare deve
		// comunque finire nel file che nel frattempo è stato aperto.
		saveTimer = setTimeout(() => {
			saveTimer = null;
			performPendingSave(currentFileId, text);
		}, SAVE_DEBOUNCE_MS);
	});

	/**
	 * Apre un file nell'editor. Le modifiche in sospeso sul file precedente
	 * vengono scritte prima di cambiare `currentFileId`, altrimenti finirebbero
	 * nel file appena aperto. Il testo caricato è per definizione già
	 * persistito, quindi l'$effect di salvataggio va zittito (suppressNextSave)
	 * e il pallino resta verde.
	 */
	function openFile(node: FileNode | null) {
		// Il primo file arriva da init(), che è asincrono: se nel frattempo
		// l'utente ha già scritto qualcosa non glielo si butta via, il suo testo
		// diventa il contenuto del file appena aperto.
		const keepUserText = node !== null && currentFileId === null && markdownText !== "";

		// Con keepUserText il debounce in corso non va forzato: scatterà da solo
		// e a quel punto scriverà nel file appena agganciato.
		if (!keepUserText && node?.id !== currentFileId) flushPendingSave();
		currentFileId = node?.id ?? null;
		if (node) adoptPendingAttachments(node.id);
		if (keepUserText) return;

		const content = node?.content ?? "";
		// Se il contenuto coincide già con quello mostrato l'$effect non viene
		// rieseguito: alzare il flag lo lascerebbe pendente e finirebbe per
		// sopprimere il salvataggio della prima vera modifica dell'utente.
		if (content !== markdownText) {
			suppressNextSave = true;
			markdownText = content;
		}
		saveStatus = "saved";
	}

	onMount(() => {
		// Carica l'albero e riapre l'ultimo file su cui si stava lavorando, così
		// ricaricando la pagina non si perde il contesto. Alla primissima
		// apertura l'albero è vuoto e init() crea il file di esempio.
		fileTree.setOpenFileHandler(openFile);
		fileTree.init().catch((err) => {
			console.error("Impossibile caricare l'albero dei file:", err);
			saveStatus = "error";
		});

		// Un file rilasciato fuori dalla drop zone farebbe navigare il browser sul
		// file stesso, buttando via il documento aperto: qui il drop viene
		// neutralizzato ovunque tranne che dove lo gestiamo noi.
		// Riguarda solo i file trascinati da fuori: un drag interno all'albero
		// dei file deve poter restare "non accettato" dove il drop è illegale,
		// altrimenti il browser mostrerebbe comunque il cursore di rilascio.
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
	 * I nodi dell'albero non hanno estensione: è l'esportazione ad aggiungere
	 * ".md", a meno che l'utente non l'abbia già messa a mano nel nome.
	 */
	function exportBaseName(): string {
		return fileTree.activeFile?.name.trim() || "document";
	}

	function markdownFileName(): string {
		const base = exportBaseName();
		return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
	}

	/**
	 * Senza allegati si scarica il solo .md, come sempre. Con allegati serve uno
	 * zip: i riferimenti "attachment:<id>" non significano nulla fuori dall'app,
	 * quindi vengono riscritti in percorsi relativi alla cartella "attachments/".
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
			console.error("Impossibile esportare il documento:", err);
		}
	}
</script>

<ModeWatcher />


<Sidebar.Provider bind:open={sidebarOpen}>
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