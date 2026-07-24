<script lang="ts">
	import { onMount } from "svelte";
	import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
	import FileTextIcon from "@lucide/svelte/icons/file-text";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import {
		listDocuments,
		listRevisions,
		deleteDocument,
		clearAllHistory,
		type DocumentRecord,
		type RevisionRecord,
	} from "$lib/history-db";

	const base = import.meta.env.BASE_URL;

	let documents: DocumentRecord[] = $state([]);
	let loading = $state(true);
	let expandedId: string | null = $state(null);
	let revisionsByDocument: Record<string, RevisionRecord[]> = $state({});

	const originLabels: Record<DocumentRecord["origin"], string> = {
		typed: "Digitato",
		pasted: "Incollato",
	};

	const changeTypeLabels: Record<RevisionRecord["changeType"], string> = {
		initial: "Versione iniziale",
		edit: "Modifica",
		paste: "Incolla",
	};

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	async function refresh() {
		loading = true;
		try {
			documents = await listDocuments();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		refresh();
	});

	async function toggleExpand(documentId: string) {
		if (expandedId === documentId) {
			expandedId = null;
			return;
		}
		expandedId = documentId;
		if (!revisionsByDocument[documentId]) {
			const revisions = await listRevisions(documentId);
			revisionsByDocument = { ...revisionsByDocument, [documentId]: revisions };
		}
	}

	function openInEditor(documentId: string, revisionId?: number) {
		const query = revisionId ? `?doc=${documentId}&rev=${revisionId}` : `?doc=${documentId}`;
		window.location.href = `${base}${query}`;
	}

	async function removeDocument(documentId: string) {
		if (!confirm("Eliminare questo documento e tutta la sua cronologia?")) return;
		await deleteDocument(documentId);
		await refresh();
	}

	async function clearHistory() {
		if (!confirm("Svuotare tutta la cronologia? L'operazione non è reversibile.")) return;
		await clearAllHistory();
		expandedId = null;
		revisionsByDocument = {};
		await refresh();
	}
</script>

<div class="mx-auto flex h-screen max-w-3xl flex-col gap-4 overflow-y-auto p-6">
	<div class="flex items-center justify-between gap-2">
		<Button variant="outline" size="sm" href={base}>
			<ArrowLeftIcon />
			Torna all'editor
		</Button>
		{#if documents.length > 0}
			<Button variant="destructive" size="sm" onclick={clearHistory}>
				<Trash2Icon />
				Svuota tutta la cronologia
			</Button>
		{/if}
	</div>

	<h1 class="text-xl font-semibold">Cronologia documenti</h1>

	{#if loading}
		<p class="text-muted-foreground text-sm">Caricamento...</p>
	{:else if documents.length === 0}
		<Alert.Root>
			<FileTextIcon />
			<Alert.Title>Nessun documento in cronologia</Alert.Title>
			<Alert.Description>
				Digita o incolla del markdown nell'editor: le modifiche verranno salvate qui automaticamente.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each documents as document (document.id)}
				<li class="border-border rounded-lg border" data-testid="history-document">
					<div class="flex items-center gap-2 p-3">
						<button
							type="button"
							class="flex flex-1 items-center gap-2 text-left"
							onclick={() => toggleExpand(document.id)}
						>
							{#if expandedId === document.id}
								<ChevronDownIcon class="size-4 shrink-0" />
							{:else}
								<ChevronRightIcon class="size-4 shrink-0" />
							{/if}
							<div class="flex min-w-0 flex-col">
									<span class="truncate font-medium" data-testid="history-document-title">{document.title}</span>
									<span class="text-muted-foreground text-xs" data-testid="history-document-meta">
									{originLabels[document.origin]} · Aggiornato il {formatDate(document.updatedAt)}
								</span>
							</div>
						</button>
						<Button size="sm" variant="outline" onclick={() => openInEditor(document.id)}>
							Apri nell'editor
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Elimina documento"
							onclick={() => removeDocument(document.id)}
						>
							<Trash2Icon />
						</Button>
					</div>

					{#if expandedId === document.id}
						<div class="border-border border-t px-3 py-2">
							{#if !revisionsByDocument[document.id]}
								<p class="text-muted-foreground text-sm">Caricamento revisioni...</p>
							{:else}
								<ul class="flex flex-col gap-1">
									{#each revisionsByDocument[document.id] as revision (revision.id)}
										<li class="flex items-center justify-between gap-2 text-sm" data-testid="history-revision">
											<span class="text-muted-foreground">
												{changeTypeLabels[revision.changeType]} · {formatDate(revision.timestamp)}
											</span>
											<Button
												size="xs"
												variant="ghost"
												onclick={() => openInEditor(document.id, revision.id)}
											>
												Ripristina questa versione
											</Button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
