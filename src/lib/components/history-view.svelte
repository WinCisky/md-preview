<script lang="ts">
	import { onMount } from "svelte";
	import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
	import FileTextIcon from "@lucide/svelte/icons/file-text";
	import FolderIcon from "@lucide/svelte/icons/folder";
	import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
	import PaperclipIcon from "@lucide/svelte/icons/paperclip";
	import Trash2Icon from "@lucide/svelte/icons/trash-2";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import {
		listDocuments,
		listRevisions,
		listAttachments,
		countAttachmentsByDocument,
		deleteDocument,
		clearAllHistory,
		type DocumentRecord,
		type RevisionRecord,
		type AttachmentRecord,
	} from "$lib/history-db";
	import { groupDocuments } from "$lib/history-groups";
	import { formatBytes } from "$lib/attachments";

	const base = import.meta.env.BASE_URL;

	let documents: DocumentRecord[] = $state([]);
	let loading = $state(true);
	let expandedId: string | null = $state(null);
	let expandedGroups: string[] = $state([]);
	let revisionsByDocument: Record<string, RevisionRecord[]> = $state({});
	let attachmentsByDocument: Record<string, AttachmentRecord[]> = $state({});
	let attachmentCounts: Record<string, number> = $state({});

	// Object URL per il download degli allegati, creati alla prima espansione e
	// revocati tutti insieme quando si lascia la pagina.
	let attachmentUrls: Record<string, string> = $state({});

	let grouped = $derived(groupDocuments(documents));

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
			const [nextDocuments, counts] = await Promise.all([
				listDocuments(),
				countAttachmentsByDocument(),
			]);
			documents = nextDocuments;
			attachmentCounts = counts;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		refresh();
		return () => {
			for (const url of Object.values(attachmentUrls)) URL.revokeObjectURL(url);
		};
	});

	function toggleGroup(key: string) {
		expandedGroups = expandedGroups.includes(key)
			? expandedGroups.filter((entry) => entry !== key)
			: [...expandedGroups, key];
	}

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
		if (!attachmentsByDocument[documentId]) {
			const attachments = await listAttachments(documentId);
			for (const attachment of attachments) {
				attachmentUrls[attachment.id] ??= URL.createObjectURL(attachment.blob);
			}
			attachmentsByDocument = { ...attachmentsByDocument, [documentId]: attachments };
		}
	}

	function openInEditor(documentId: string, revisionId?: number) {
		const query = revisionId ? `?doc=${documentId}&rev=${revisionId}` : `?doc=${documentId}`;
		window.location.href = `${base}${query}`;
	}

	async function removeDocument(documentId: string) {
		if (!confirm("Eliminare questo documento, la sua cronologia e i suoi allegati?")) return;
		await deleteDocument(documentId);
		releaseCaches(documentId);
		await refresh();
	}

	async function clearHistory() {
		if (!confirm("Svuotare tutta la cronologia? L'operazione non è reversibile.")) return;
		await clearAllHistory();
		expandedId = null;
		expandedGroups = [];
		revisionsByDocument = {};
		for (const url of Object.values(attachmentUrls)) URL.revokeObjectURL(url);
		attachmentUrls = {};
		attachmentsByDocument = {};
		await refresh();
	}

	/** Scarta le cache di un documento eliminato, revocandone gli object URL. */
	function releaseCaches(documentId: string) {
		for (const attachment of attachmentsByDocument[documentId] ?? []) {
			const url = attachmentUrls[attachment.id];
			if (url) {
				URL.revokeObjectURL(url);
				delete attachmentUrls[attachment.id];
			}
		}
		delete attachmentsByDocument[documentId];
		delete revisionsByDocument[documentId];
		if (expandedId === documentId) expandedId = null;
	}
</script>

{#snippet documentRow(doc: DocumentRecord)}
	<li class="border-border rounded-lg border" data-testid="history-document">
		<div class="flex flex-wrap items-center gap-2 p-3">
			<button
				type="button"
				class="flex basis-full items-center gap-2 text-left sm:flex-1 sm:basis-auto"
				onclick={() => toggleExpand(doc.id)}
			>
				{#if expandedId === doc.id}
					<ChevronDownIcon class="size-4 shrink-0" />
				{:else}
					<ChevronRightIcon class="size-4 shrink-0" />
				{/if}
				<div class="flex min-w-0 flex-col">
					<span class="flex min-w-0 items-center gap-1.5">
						<span class="truncate font-medium" data-testid="history-document-title">{doc.title}</span>
						{#if attachmentCounts[doc.id]}
							<span
								class="text-muted-foreground flex shrink-0 items-center gap-0.5 text-xs"
								data-testid="history-attachment-count"
								title="{attachmentCounts[doc.id]} allegati"
							>
								<PaperclipIcon class="size-3" />
								{attachmentCounts[doc.id]}
							</span>
						{/if}
					</span>
					<span class="text-muted-foreground text-xs" data-testid="history-document-meta">
						{originLabels[doc.origin]} · Aggiornato il {formatDate(doc.updatedAt)}
					</span>
				</div>
			</button>
			<Button size="sm" variant="outline" onclick={() => openInEditor(doc.id)}>
				Apri nell'editor
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Elimina documento"
				onclick={() => removeDocument(doc.id)}
			>
				<Trash2Icon />
			</Button>
		</div>

		{#if expandedId === doc.id}
			<div class="border-border flex flex-col gap-3 border-t px-3 py-2">
				{#if !revisionsByDocument[doc.id]}
					<p class="text-muted-foreground text-sm">Caricamento...</p>
				{:else}
					{#if attachmentsByDocument[doc.id]?.length}
						<div class="flex flex-col gap-1">
							<h2 class="text-muted-foreground text-xs font-semibold uppercase">Allegati</h2>
							<ul class="flex flex-col gap-1">
								{#each attachmentsByDocument[doc.id] as attachment (attachment.id)}
									<li
										class="flex flex-wrap items-center justify-between gap-2 text-sm"
										data-testid="history-attachment"
									>
										<span class="flex min-w-0 items-center gap-1.5">
											<PaperclipIcon class="text-muted-foreground size-3 shrink-0" />
											<span class="truncate">{attachment.name}</span>
											<span class="text-muted-foreground shrink-0 text-xs">
												{formatBytes(attachment.size)}
											</span>
										</span>
										<Button
											size="xs"
											variant="ghost"
											href={attachmentUrls[attachment.id]}
											download={attachment.name}
										>
											Scarica
										</Button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<div class="flex flex-col gap-1">
						<h2 class="text-muted-foreground text-xs font-semibold uppercase">Revisioni</h2>
						<ul class="flex flex-col gap-1">
							{#each revisionsByDocument[doc.id] as revision (revision.id)}
								<li
									class="flex flex-wrap items-center justify-between gap-2 text-sm"
									data-testid="history-revision"
								>
									<span class="text-muted-foreground">
										{changeTypeLabels[revision.changeType]} · {formatDate(revision.timestamp)}
									</span>
									<Button size="xs" variant="ghost" onclick={() => openInEditor(doc.id, revision.id)}>
										Ripristina questa versione
									</Button>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</li>
{/snippet}

<!-- min-h-svh invece di h-screen + scroller interno: lasciando scorrere la
     pagina le barre del browser mobile possono collassare normalmente. -->
<div class="mx-auto flex min-h-svh max-w-3xl flex-col gap-4 p-4 sm:p-6">
	<div class="flex flex-wrap items-center justify-between gap-2">
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
		<div class="flex flex-col gap-2">
			{#if grouped.current.length > 0}
				<ul class="flex flex-col gap-2">
					{#each grouped.current as doc (doc.id)}
						{@render documentRow(doc)}
					{/each}
				</ul>
			{/if}

			{#each grouped.groups as group (group.key)}
				<div data-testid="history-group" data-group-key={group.key}>
					<button
						type="button"
						class="hover:bg-accent/50 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left"
						onclick={() => toggleGroup(group.key)}
					>
						{#if expandedGroups.includes(group.key)}
							<ChevronDownIcon class="size-4 shrink-0" />
							<FolderOpenIcon class="size-4 shrink-0" />
						{:else}
							<ChevronRightIcon class="size-4 shrink-0" />
							<FolderIcon class="size-4 shrink-0" />
						{/if}
						<span class="font-medium" data-testid="history-group-label">{group.label}</span>
						<span class="text-muted-foreground text-xs">{group.documents.length}</span>
					</button>

					{#if expandedGroups.includes(group.key)}
						<ul class="mt-2 flex flex-col gap-2 pl-4">
							{#each group.documents as doc (doc.id)}
								{@render documentRow(doc)}
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
