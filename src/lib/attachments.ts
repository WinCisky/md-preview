/**
 * Helper per gli allegati (immagini e file generici) inseriti nell'editor.
 *
 * Nel testo markdown un allegato è sempre e solo un riferimento della forma
 * `attachment:<uuid>`: i byte vivono in IndexedDB (vedi history-db.ts). Questo
 * mantiene compatto il contenuto salvato — ogni revisione è uno snapshot
 * completo del testo, quindi incorporare i file in base64 significherebbe
 * duplicarli ad ogni salvataggio.
 *
 * Il riferimento viene risolto in due momenti diversi:
 * - a schermo, sostituendolo con un object URL prima della sanitizzazione;
 * - in esportazione, sostituendolo con un percorso relativo dentro uno zip.
 */

import { zipSync, strToU8 } from "fflate";
import type { AttachmentRecord } from "$lib/history-db";

/** Oltre questa soglia il file non viene allegato (IndexedDB è per-origine). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Un allegato già caricato e pronto per essere mostrato nell'anteprima. */
export interface ResolvedAttachment {
	url: string;
	name: string;
}

/** `attachment:<uuid>` ovunque compaia (sorgente markdown o HTML generato). */
const ATTACHMENT_REF = /attachment:([0-9a-fA-F][0-9a-fA-F-]*)/g;

/** Lo stesso riferimento ma nella posizione di un attributo dell'HTML di marked. */
const ATTACHMENT_ATTR = /(src|href)="attachment:([0-9a-fA-F][0-9a-fA-F-]*)"/g;

/**
 * DOMPurify di default non ammette lo schema `blob:` (non è nella sua
 * ALLOWED_URI_REGEXP), quindi gli object URL degli allegati verrebbero
 * rimossi dall'HTML sanitizzato. Qui si riprende la regexp predefinita
 * aggiungendo `blob` alla lista degli schemi consentiti.
 */
export const SANITIZE_CONFIG = {
	ALLOWED_URI_REGEXP:
		/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
	ADD_ATTR: ["download"],
};

export function isImageAttachment(mimeType: string): boolean {
	return mimeType.startsWith("image/");
}

/** Gli id di tutti gli allegati referenziati da un testo, senza duplicati. */
export function extractAttachmentIds(text: string): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(ATTACHMENT_REF)) {
		ids.add(match[1]);
	}
	return [...ids];
}

/** Lo snippet markdown da inserire nell'editor per un allegato appena salvato. */
export function attachmentMarkdown(attachment: AttachmentRecord): string {
	const label = attachment.name.replace(/[[\]]/g, "");
	const link = `[${label}](attachment:${attachment.id})`;
	return isImageAttachment(attachment.mimeType) ? `!${link}` : link;
}

/**
 * Sostituisce i riferimenti `attachment:<id>` con gli object URL già caricati.
 * Va eseguito prima di DOMPurify, così il sanitizer vede un URL normale.
 * I riferimenti non ancora risolti restano invariati e vengono scartati dalla
 * sanitizzazione: è lo stato transitorio mentre il blob viene letto da IndexedDB.
 */
export function resolveAttachmentUrls(
	html: string,
	resolved: Record<string, ResolvedAttachment>,
): string {
	return html.replace(ATTACHMENT_ATTR, (match, attribute: string, id: string) => {
		const attachment = resolved[id];
		if (!attachment) return match;
		// download: cliccando un allegato non-immagine il browser salva il file
		// con il suo nome originale invece di aprire un blob senza estensione.
		const download =
			attribute === "href" ? ` download="${attachment.name.replace(/"/g, "&quot;")}"` : "";
		return `${attribute}="${attachment.url}"${download}`;
	});
}

/** "1.4 MB", "832 B", … */
export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	const units = ["KB", "MB", "GB"];
	let value = size / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

/** Nome file sicuro per lo zip: niente separatori di percorso né caratteri di controllo. */
function safeFileName(name: string, fallback: string): string {
	const cleaned = [...name.replace(/[/\\]/g, "-")]
		.filter((char) => char.codePointAt(0)! > 31 && !'<>:"|?*'.includes(char))
		.join("")
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Costruisce lo zip esportabile di un documento: `document.md` con i
 * riferimenti riscritti in percorsi relativi, più la cartella `attachments/`
 * con i file veri e propri. Compressione disattivata (`level: 0`): immagini e
 * PDF sono già compressi, ricomprimerli costerebbe tempo senza guadagno.
 */
export async function buildExportZip(
	markdown: string,
	attachments: AttachmentRecord[],
): Promise<Blob> {
	const usedNames = new Set<string>();
	const pathById = new Map<string, string>();
	const files: Record<string, Uint8Array> = {};

	for (const attachment of attachments) {
		const base = safeFileName(attachment.name, attachment.id);
		let name = base;
		let suffix = 1;
		while (usedNames.has(name)) {
			const dot = base.lastIndexOf(".");
			name = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
			suffix++;
		}
		usedNames.add(name);
		pathById.set(attachment.id, `attachments/${name}`);
		files[`attachments/${name}`] = new Uint8Array(await attachment.blob.arrayBuffer());
	}

	const rewritten = markdown.replace(ATTACHMENT_REF, (match, id: string) => {
		const path = pathById.get(id);
		// encodeURI e non encodeURIComponent: lo "/" della cartella va preservato.
		return path ? encodeURI(path) : match;
	});
	files["document.md"] = strToU8(rewritten);

	return new Blob([zipSync(files, { level: 0 })], { type: "application/zip" });
}
