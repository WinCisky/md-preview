/**
 * Helpers for the attachments (images and generic files) inserted in the
 * editor.
 *
 * In the markdown text an attachment is always and only a reference of the
 * form `attachment:<uuid>`: the bytes live in IndexedDB (see files-db.ts).
 * This keeps the saved content compact: embedding the files as base64 would
 * mean rewriting them on every save of the text.
 *
 * The reference is resolved at two different moments:
 * - on screen, replacing it with an object URL before sanitization;
 * - on export, replacing it with a relative path inside a zip.
 */

import { zipSync, strToU8 } from "fflate";
import type { AttachmentRecord } from "$lib/files-db";

/** Past this threshold the file is not attached (IndexedDB is per-origin). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** An attachment already loaded and ready to be shown in the preview. */
export interface ResolvedAttachment {
	url: string;
	name: string;
}

/** `attachment:<uuid>` wherever it appears (markdown source or generated HTML). */
const ATTACHMENT_REF = /attachment:([0-9a-fA-F][0-9a-fA-F-]*)/g;

/** The same reference but in the position of an attribute in marked's HTML. */
const ATTACHMENT_ATTR = /(src|href)="attachment:([0-9a-fA-F][0-9a-fA-F-]*)"/g;

/**
 * By default DOMPurify does not allow the `blob:` scheme (it is not in its
 * ALLOWED_URI_REGEXP), so the attachments' object URLs would be stripped from
 * the sanitized HTML. Here the default regexp is taken back with `blob` added
 * to the list of allowed schemes.
 */
export const SANITIZE_CONFIG = {
	ALLOWED_URI_REGEXP:
		/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
	ADD_ATTR: ["download"],
};

export function isImageAttachment(mimeType: string): boolean {
	return mimeType.startsWith("image/");
}

/** The ids of every attachment referenced by a text, without duplicates. */
export function extractAttachmentIds(text: string): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(ATTACHMENT_REF)) {
		ids.add(match[1]);
	}
	return [...ids];
}

/** The markdown snippet to insert in the editor for a just-saved attachment. */
export function attachmentMarkdown(attachment: AttachmentRecord): string {
	const label = attachment.name.replace(/[[\]]/g, "");
	const link = `[${label}](attachment:${attachment.id})`;
	return isImageAttachment(attachment.mimeType) ? `!${link}` : link;
}

/**
 * Replaces the `attachment:<id>` references with the object URLs already
 * loaded. It has to run before DOMPurify, so the sanitizer sees a normal URL.
 * References not yet resolved are left unchanged and get dropped by the
 * sanitization: that is the transient state while the blob is read from
 * IndexedDB.
 */
export function resolveAttachmentUrls(
	html: string,
	resolved: Record<string, ResolvedAttachment>,
): string {
	return html.replace(ATTACHMENT_ATTR, (match, attribute: string, id: string) => {
		const attachment = resolved[id];
		if (!attachment) return match;
		// download: clicking a non-image attachment makes the browser save the
		// file under its original name instead of opening an extension-less blob.
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

/** A zip-safe file name: no path separators and no control characters. */
function safeFileName(name: string, fallback: string): string {
	const cleaned = [...name.replace(/[/\\]/g, "-")]
		.filter((char) => char.codePointAt(0)! > 31 && !'<>:"|?*'.includes(char))
		.join("")
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Builds the exportable zip of a document: the markdown (under the name
 * `markdownName`) with the references rewritten into relative paths, plus the
 * `attachments/` folder with the actual files. Compression is off
 * (`level: 0`): images and PDFs are already compressed, recompressing them
 * would cost time for no gain.
 */
export async function buildExportZip(
	markdown: string,
	attachments: AttachmentRecord[],
	markdownName: string,
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
		// encodeURI and not encodeURIComponent: the folder's "/" must be preserved.
		return path ? encodeURI(path) : match;
	});
	// The name comes from the one the user chose in the tree: without cleaning
	// it a "/" would create a folder inside the zip.
	files[safeFileName(markdownName, "document.md")] = strToU8(rewritten);

	return new Blob([zipSync(files, { level: 0 })], { type: "application/zip" });
}
