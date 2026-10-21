/**
 * Markdown → Word (.docx) export, with no extra dependencies.
 *
 * A .docx is a zip of a few WordprocessingML XML parts. This module builds
 * them straight from the `marked` token tree (the same lexer and extensions as
 * the preview) and zips them with fflate, which the app already ships for the
 * markdown export. It works on tokens instead of the rendered HTML: no DOM
 * walking, no sanitization round trip, and every markdown construct maps to
 * a native Word one (real headings, lists, tables, hyperlinks, images).
 *
 * The module is meant to be loaded lazily (dynamic import) when the user
 * exports, so it costs nothing on page load.
 *
 * Images are embedded: attachments come from IndexedDB through
 * `resolveAttachment`, data: and remote URLs are fetched (remote ones may fail
 * because of CORS, in which case the alt text is written instead). Formats
 * Word can't display (WebP, SVG, AVIF, …) are converted to PNG via a canvas.
 */

import { zipSync, strToU8, type Zippable } from "fflate";
import type { Token, Tokens } from "marked";
import { marked } from "$lib/markdown";

export interface DocxOptions {
	/** Document title (written in the file properties). */
	title: string;
	/** Returns the blob of an `attachment:<id>` reference, if any. */
	resolveAttachment?: (id: string) => Promise<Blob | null | undefined>;
}

export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A4 with 2.54 cm margins, in twentieths of a point (twips).
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const PAGE_MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;
const CONTENT_HEIGHT = PAGE_HEIGHT - 2 * PAGE_MARGIN;
const EMU_PER_TWIP = 635;
const EMU_PER_PX = 9525; // at 96 dpi
const LIST_INDENT = 720;
const QUOTE_INDENT = 240;
const BULLET_NUM_ID = 1;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;
const MAX_CANVAS_SIDE = 4096;

const ALERT_STYLES: Record<string, { title: string; color: string }> = {
	note: { title: "Note", color: "0969DA" },
	tip: { title: "Tip", color: "1A7F37" },
	important: { title: "Important", color: "8250DF" },
	warning: { title: "Warning", color: "9A6700" },
	caution: { title: "Caution", color: "D1242F" },
};

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_HYPERLINK = `${REL}/hyperlink`;
const REL_IMAGE = `${REL}/image`;

// ---------------------------------------------------------------------------
// XML helpers

// Characters not allowed in XML 1.0 (control chars, lone surrogates): a single
// one would make Word refuse the whole file.
const INVALID_XML_CHARS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function esc(text: string): string {
	return text
		.replace(INVALID_XML_CHARS, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

let entityDecoder: HTMLTextAreaElement | undefined;

/**
 * marked keeps entities (`&amp;`, `&copy;`, `&#169;`) verbatim in text tokens:
 * the browser decodes them in the preview, here it has to be done by hand. A
 * textarea parses its content as plain text, so nothing gets executed.
 */
function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	entityDecoder ??= document.createElement("textarea");
	entityDecoder.innerHTML = text;
	return entityDecoder.value;
}

/** The readable text of a raw HTML block (tags dropped, line breaks kept). */
function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "");
	return decodeEntities(text)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Only links that make sense outside the app, encoded as a valid URI. */
function safeHref(href: string | undefined): string | null {
	if (!href) return null;
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#") || /^attachment:/i.test(trimmed)) return null;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1].toLowerCase();
	if (scheme && !["http", "https", "mailto", "tel", "ftp"].includes(scheme)) return null;
	try {
		let decoded = trimmed;
		try {
			decoded = decodeURI(trimmed);
		} catch {
			// Already contains a lone "%": encode it as is.
		}
		const encoded = encodeURI(decoded);
		new URL(encoded, "https://example.invalid/");
		return encoded;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Formatting

interface RunStyle {
	bold?: boolean;
	italic?: boolean;
	strike?: boolean;
	code?: boolean;
	sub?: boolean;
	sup?: boolean;
	mark?: boolean;
	link?: boolean;
	/** Inside a <w:hyperlink>: nested hyperlinks are not allowed. */
	inLink?: boolean;
	color?: string;
}

// The child elements are emitted in the order mandated by the schema: Word
// rejects out-of-order properties as corrupted content.
function rPr(style: RunStyle): string {
	let xml = "";
	if (style.link) xml += '<w:rStyle w:val="Hyperlink"/>';
	if (style.code) xml += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
	if (style.bold) xml += "<w:b/>";
	if (style.italic) xml += "<w:i/>";
	if (style.strike) xml += "<w:strike/>";
	if (style.color && !style.link) xml += `<w:color w:val="${style.color}"/>`;
	if (style.code) xml += '<w:sz w:val="20"/>';
	if (style.mark) xml += '<w:highlight w:val="yellow"/>';
	if (style.code) xml += '<w:shd w:val="clear" w:color="auto" w:fill="EFF1F3"/>';
	if (style.sub) xml += '<w:vertAlign w:val="subscript"/>';
	else if (style.sup) xml += '<w:vertAlign w:val="superscript"/>';
	return xml ? `<w:rPr>${xml}</w:rPr>` : "";
}

interface ParagraphProps {
	style?: string;
	keepNext?: boolean;
	num?: { id: number; level: number };
	leftBorder?: string;
	bottomBorder?: string;
	spacingAfter?: number;
	indent?: { left: number; hanging?: number };
	align?: string;
}

function pPr(props: ParagraphProps): string {
	let xml = "";
	if (props.style) xml += `<w:pStyle w:val="${props.style}"/>`;
	if (props.keepNext) xml += "<w:keepNext/>";
	if (props.num) xml += `<w:numPr><w:ilvl w:val="${props.num.level}"/><w:numId w:val="${props.num.id}"/></w:numPr>`;
	if (props.leftBorder || props.bottomBorder) {
		xml += "<w:pBdr>";
		if (props.leftBorder) xml += `<w:left w:val="single" w:sz="18" w:space="8" w:color="${props.leftBorder}"/>`;
		if (props.bottomBorder) xml += `<w:bottom w:val="single" w:sz="6" w:space="1" w:color="${props.bottomBorder}"/>`;
		xml += "</w:pBdr>";
	}
	if (props.spacingAfter !== undefined) xml += `<w:spacing w:after="${props.spacingAfter}"/>`;
	if (props.indent) {
		const hanging = props.indent.hanging ? ` w:hanging="${props.indent.hanging}"` : "";
		xml += `<w:ind w:left="${props.indent.left}"${hanging}/>`;
	}
	if (props.align) xml += `<w:jc w:val="${props.align}"/>`;
	return xml ? `<w:pPr>${xml}</w:pPr>` : "";
}

// ---------------------------------------------------------------------------
// Images

interface EmbeddedImage {
	bytes: Uint8Array;
	ext: "png" | "jpeg" | "gif" | "bmp";
	width: number;
	height: number;
	relId?: string;
}

/** The formats Word renders natively, recognized from their magic bytes. */
function sniffImage(bytes: Uint8Array): EmbeddedImage["ext"] | null {
	const [b0, b1, b2, b3] = bytes;
	if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return "png";
	if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return "jpeg";
	if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return "gif";
	if (b0 === 0x42 && b1 === 0x4d) return "bmp";
	return null;
}

async function prepareImage(blob: Blob): Promise<EmbeddedImage | null> {
	const url = URL.createObjectURL(blob);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const ext = sniffImage(bytes);
		const width = image.naturalWidth;
		const height = image.naturalHeight;
		if (ext && width > 0 && height > 0) return { bytes, ext, width, height };

		// Unsupported format (or an SVG with no intrinsic size): rasterize it.
		let targetWidth = width || 600;
		let targetHeight = height || Math.round(targetWidth / 2);
		const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(targetWidth, targetHeight));
		targetWidth = Math.max(1, Math.round(targetWidth * scale));
		targetHeight = Math.max(1, Math.round(targetHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = targetWidth;
		canvas.height = targetHeight;
		canvas.getContext("2d")?.drawImage(image, 0, 0, targetWidth, targetHeight);
		const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!png) return null;
		return {
			bytes: new Uint8Array(await png.arrayBuffer()),
			ext: "png",
			width: width || targetWidth,
			height: height || targetHeight,
		};
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function loadImage(href: string, options: DocxOptions): Promise<EmbeddedImage | null> {
	try {
		let blob: Blob | null | undefined;
		const url = href.trim();
		const attachment = /^attachment:([0-9a-fA-F-]+)$/.exec(url);
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
		if (attachment) {
			blob = await options.resolveAttachment?.(attachment[1]);
		} else if (!scheme || ["http", "https", "data", "blob"].includes(scheme)) {
			const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS) });
			blob = response.ok ? await response.blob() : null;
		}
		return blob ? await prepareImage(blob) : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Document body

interface BlockContext {
	/** Left indentation of the content, in twips. */
	indent: number;
	/** Color of the left bar (blockquotes, alerts). */
	bar?: string;
	/** Base run formatting (e.g. the gray text of quotes). */
	run: RunStyle;
	listDepth: number;
	/** Inside the items of a tight list: no space between paragraphs. */
	tight?: boolean;
}

interface ListMarker {
	id: number;
	level: number;
	/** Runs prepended to the item's first paragraph (task checkbox). */
	prefix: string;
}

class DocxWriter {
	private rels: string[] = [];
	private hyperlinkRels = new Map<string, string>();
	private orderedNums: { id: number; level: number; start: number }[] = [];
	private nextNumId = BULLET_NUM_ID + 1;
	private drawingId = 0;
	private media: Record<string, Uint8Array> = {};
	/** Pending numbering, consumed by the first paragraph of a list item. */
	private marker: ListMarker | null = null;
	/** Width available to images in the current block, in twips. */
	private availableWidth = CONTENT_WIDTH;

	constructor(private images: Map<string, EmbeddedImage | null>) {}

	private addRel(type: string, target: string, external = false): string {
		const id = `rId${this.rels.length + 1}`;
		const mode = external ? ' TargetMode="External"' : "";
		this.rels.push(`<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${mode}/>`);
		return id;
	}

	// --- inline -------------------------------------------------------------

	private run(text: string, style: RunStyle, keepBreaks = false): string {
		if (!text) return "";
		let body = "";
		for (const part of text.split(/(\t|\r?\n)/)) {
			if (part === "") continue;
			if (part === "\t") body += "<w:tab/>";
			else if (part === "\n" || part === "\r\n")
				body += keepBreaks ? "<w:br/>" : '<w:t xml:space="preserve"> </w:t>';
			else body += `<w:t xml:space="preserve">${esc(part)}</w:t>`;
		}
		return `<w:r>${rPr(style)}${body}</w:r>`;
	}

	private inline(tokens: Token[] | undefined, style: RunStyle): string {
		let xml = "";
		for (const token of tokens ?? []) xml += this.inlineToken(token, style);
		return xml;
	}

	private inlineToken(token: Token, style: RunStyle): string {
		switch (token.type) {
			case "text":
				return "tokens" in token && token.tokens
					? this.inline(token.tokens, style)
					: this.run(decodeEntities(token.text), style);
			case "escape":
				return this.run(token.text, style);
			case "strong":
				return this.inline(token.tokens, { ...style, bold: true });
			case "em":
				return this.inline(token.tokens, { ...style, italic: true });
			case "del":
				return this.inline(token.tokens, { ...style, strike: true });
			case "sub":
				return this.inline(token.tokens, { ...style, sub: true });
			case "sup":
				return this.inline(token.tokens, { ...style, sup: true });
			case "mark":
				return this.inline(token.tokens, { ...style, mark: true });
			case "codespan":
				return this.run(token.text, { ...style, code: true });
			case "br":
				return "<w:r><w:br/></w:r>";
			case "link":
				return this.link(token as Tokens.Link, style);
			case "image":
				return this.image(token as Tokens.Image, style);
			case "html":
				return /^<br\s*\/?>$/i.test(token.text.trim()) ? "<w:r><w:br/></w:r>" : "";
			case "checkbox":
				return "";
			default:
				if ("tokens" in token && Array.isArray(token.tokens)) return this.inline(token.tokens, style);
				return "text" in token && typeof token.text === "string" ? this.run(token.text, style) : "";
		}
	}

	private link(token: Tokens.Link, style: RunStyle): string {
		const target = style.inLink ? null : safeHref(token.href);
		if (!target) return this.inline(token.tokens, style);
		let relId = this.hyperlinkRels.get(target);
		if (!relId) {
			relId = this.addRel(REL_HYPERLINK, target, true);
			this.hyperlinkRels.set(target, relId);
		}
		const runs = this.inline(token.tokens, { ...style, link: true, inLink: true });
		return `<w:hyperlink r:id="${relId}" w:history="1">${runs}</w:hyperlink>`;
	}

	private image(token: Tokens.Image, style: RunStyle): string {
		const alt = decodeEntities(token.text ?? "");
		const image = this.images.get(token.href);
		if (!image) return alt ? this.run(`[${alt}]`, { ...style, italic: true }) : "";

		if (!image.relId) {
			const name = `image${Object.keys(this.media).length + 1}.${image.ext}`;
			this.media[`word/media/${name}`] = image.bytes;
			image.relId = this.addRel(REL_IMAGE, `media/${name}`);
		}

		// Natural size at 96 dpi, scaled down to fit the page.
		let cx = image.width * EMU_PER_PX;
		let cy = image.height * EMU_PER_PX;
		const scale = Math.min(
			1,
			(Math.max(this.availableWidth, 1440) * EMU_PER_TWIP) / cx,
			(CONTENT_HEIGHT * EMU_PER_TWIP) / cy,
		);
		cx = Math.max(1, Math.round(cx * scale));
		cy = Math.max(1, Math.round(cy * scale));
		const id = ++this.drawingId;
		const descr = esc(alt);
		return (
			`<w:r>${rPr({ link: style.link })}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
			`<wp:extent cx="${cx}" cy="${cy}"/>` +
			`<wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/>` +
			'<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
			'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
			`<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>` +
			`<pic:blipFill><a:blip r:embed="${image.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
			`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
			'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
			"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
		);
	}

	// --- blocks -------------------------------------------------------------

	private paragraph(content: string, ctx: BlockContext, props: ParagraphProps = {}): string {
		const merged: ParagraphProps = { ...props };
		if (ctx.bar && !merged.leftBorder) merged.leftBorder = ctx.bar;
		if (ctx.tight && merged.spacingAfter === undefined) merged.spacingAfter = 60;
		const marker = this.marker;
		if (marker) {
			this.marker = null;
			merged.num = { id: marker.id, level: marker.level };
			merged.indent = { left: ctx.indent, hanging: LIST_INDENT / 2 };
			content = marker.prefix + content;
		} else if (ctx.indent > 0 && !merged.indent) {
			merged.indent = { left: ctx.indent };
		}
		return `<w:p>${pPr(merged)}${content}</w:p>`;
	}

	/** A list item that does not start with a paragraph still needs its bullet. */
	private flushMarker(ctx: BlockContext): string {
		return this.marker ? this.paragraph("", ctx) : "";
	}

	private inlineAt(tokens: Token[] | undefined, style: RunStyle, width: number): string {
		this.availableWidth = width;
		return this.inline(tokens, style);
	}

	blocks(tokens: Token[], ctx: BlockContext): string {
		let xml = "";
		for (const token of tokens) xml += this.block(token, ctx);
		return xml;
	}

	private block(token: Token, ctx: BlockContext): string {
		const width = CONTENT_WIDTH - ctx.indent;
		switch (token.type) {
			case "space":
			case "def":
			case "checkbox":
				return "";
			case "heading": {
				const depth = Math.min(Math.max((token as Tokens.Heading).depth, 1), 6);
				return this.paragraph(this.inlineAt(token.tokens, ctx.run, width), ctx, { style: `Heading${depth}` });
			}
			case "paragraph":
			case "text":
				return this.paragraph(
					"tokens" in token && token.tokens
						? this.inlineAt(token.tokens, ctx.run, width)
						: this.run(decodeEntities(token.text), ctx.run),
					ctx,
				);
			case "code": {
				const code = (token as Tokens.Code).text.replace(/\n$/, "");
				return this.paragraph(this.run(code, ctx.run, true), ctx, { style: "SourceCode" });
			}
			case "blockquote":
				return this.blocks(token.tokens ?? [], {
					...ctx,
					indent: ctx.indent + QUOTE_INDENT,
					bar: "D0D7DE",
					run: { ...ctx.run, color: "59636E" },
				});
			case "alert": {
				const alert = ALERT_STYLES[token.alertType] ?? ALERT_STYLES.note;
				const alertCtx = { ...ctx, indent: ctx.indent + QUOTE_INDENT, bar: alert.color };
				return (
					this.paragraph(this.run(alert.title, { bold: true, color: alert.color }), alertCtx, {
						keepNext: true,
						spacingAfter: 60,
					}) + this.blocks(token.tokens ?? [], alertCtx)
				);
			}
			case "list":
				return this.list(token as Tokens.List, ctx);
			case "table":
				return this.table(token as Tokens.Table, ctx);
			case "hr":
				return this.paragraph("", ctx, { bottomBorder: "D0D7DE" });
			case "html": {
				const text = htmlToText(token.text);
				return text ? this.paragraph(this.run(text, ctx.run, true), ctx) : "";
			}
			case "definitionList": {
				let xml = "";
				const definitionCtx = { ...ctx, indent: ctx.indent + LIST_INDENT };
				for (const item of token.items as {
					term: Token[];
					definitions: { blocks: boolean; tokens: Token[] }[];
				}[]) {
					xml += this.paragraph(this.inlineAt(item.term, { ...ctx.run, bold: true }, width), ctx, {
						keepNext: true,
						spacingAfter: 60,
					});
					for (const definition of item.definitions) {
						xml += definition.blocks
							? this.blocks(definition.tokens, definitionCtx)
							: this.paragraph(
									this.inlineAt(definition.tokens, ctx.run, width - LIST_INDENT),
									definitionCtx,
								);
					}
				}
				return xml;
			}
			default:
				// Unknown token from a future extension: keep its content.
				if ("tokens" in token && Array.isArray(token.tokens))
					return this.paragraph(this.inlineAt(token.tokens, ctx.run, width), ctx);
				if ("text" in token && typeof token.text === "string" && token.text.trim())
					return this.paragraph(this.run(token.text, ctx.run, true), ctx);
				return "";
		}
	}

	private list(token: Tokens.List, ctx: BlockContext): string {
		let xml = this.flushMarker(ctx);
		const level = Math.min(ctx.listDepth, 8);
		let id = BULLET_NUM_ID;
		if (token.ordered) {
			// Every ordered list gets its own numbering instance, so it restarts.
			id = this.nextNumId++;
			const start = typeof token.start === "number" ? token.start : 1;
			this.orderedNums.push({ id, level, start });
		}
		const itemCtx: BlockContext = {
			...ctx,
			indent: ctx.indent + LIST_INDENT,
			listDepth: ctx.listDepth + 1,
			tight: !token.loose,
		};
		for (const item of token.items) {
			const prefix = item.task ? this.run(item.checked ? "☒ " : "☐ ", ctx.run) : "";
			this.marker = { id, level, prefix };
			xml += this.blocks(item.tokens, itemCtx);
			xml += this.flushMarker(itemCtx);
		}
		return xml;
	}

	private table(token: Tokens.Table, ctx: BlockContext): string {
		let xml = this.flushMarker(ctx);
		const columns = Math.max(token.header.length, 1);
		const tableWidth = CONTENT_WIDTH - ctx.indent;
		const cellWidth = Math.floor(tableWidth / columns);
		const cell = (data: Tokens.TableCell | undefined, index: number, header: boolean) => {
			const align = token.align[index];
			const style = header ? { ...ctx.run, bold: true } : ctx.run;
			const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>' : "";
			return (
				`<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/>${shading}</w:tcPr>` +
				`<w:p>${pPr({ spacingAfter: 0, align: align ?? undefined })}` +
				this.inlineAt(data?.tokens, style, cellWidth - 200) +
				"</w:p></w:tc>"
			);
		};
		const row = (cells: Tokens.TableCell[], header: boolean) => {
			let cellsXml = "";
			for (let index = 0; index < columns; index++) cellsXml += cell(cells[index], index, header);
			return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cellsXml}</w:tr>`;
		};
		const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>`;

		xml +=
			"<w:tbl><w:tblPr>" +
			`<w:tblW w:w="${cellWidth * columns}" w:type="dxa"/>` +
			(ctx.indent > 0 ? `<w:tblInd w:w="${ctx.indent}" w:type="dxa"/>` : "") +
			`<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
			'<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>' +
			'<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
			"</w:tblPr><w:tblGrid>" +
			`<w:gridCol w:w="${cellWidth}"/>`.repeat(columns) +
			"</w:tblGrid>" +
			row(token.header, true) +
			token.rows.map((cells) => row(cells, false)).join("") +
			"</w:tbl>";
		// Two adjacent tables would be merged by Word: always separate them.
		return xml + `<w:p>${pPr({ spacingAfter: 0 })}</w:p>`;
	}

	// --- package parts ------------------------------------------------------

	documentXml(body: string): string {
		return (
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
			` xmlns:r="${REL}"` +
			' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
			' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
			' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
			`<w:body>${body || "<w:p/>"}` +
			`<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
			`<w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="708" w:footer="708" w:gutter="0"/>` +
			"</w:sectPr></w:body></w:document>"
		);
	}

	numberingXml(): string {
		const bullets = ["•", "◦", "▪"];
		const formats = ["decimal", "lowerLetter", "lowerRoman"];
		const level = (ilvl: number, numFmt: string, text: string, font = "") =>
			`<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>` +
			`<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
			`<w:pPr><w:ind w:left="${LIST_INDENT * (ilvl + 1)}" w:hanging="${LIST_INDENT / 2}"/></w:pPr>` +
			(font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : "") +
			"</w:lvl>";
		let bulletLevels = "";
		let orderedLevels = "";
		for (let ilvl = 0; ilvl < 9; ilvl++) {
			bulletLevels += level(ilvl, "bullet", bullets[ilvl % 3], "Arial");
			orderedLevels += level(ilvl, formats[ilvl % 3], `%${ilvl + 1}.`);
		}
		const nums = this.orderedNums
			.map(
				({ id, level: ilvl, start }) =>
					`<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>` +
					`<w:lvlOverride w:ilvl="${ilvl}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`,
			)
			.join("");
		return (
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			`<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum>` +
			`<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${orderedLevels}</w:abstractNum>` +
			`<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>${nums}` +
			"</w:numbering>"
		);
	}

	/** Builds the zip. Must be called after the body has been rendered. */
	pack(body: string, title: string): Blob {
		this.addRel(`${REL}/styles`, "styles.xml");
		this.addRel(`${REL}/numbering`, "numbering.xml");

		const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
		const files: Zippable = {
			"[Content_Types].xml": strToU8(CONTENT_TYPES),
			"_rels/.rels": strToU8(ROOT_RELS),
			"docProps/core.xml": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
					' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
					' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
					`<dc:title>${esc(title)}</dc:title>` +
					`<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
					`<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
					"</cp:coreProperties>",
			),
			"word/document.xml": strToU8(this.documentXml(body)),
			"word/styles.xml": strToU8(STYLES),
			"word/numbering.xml": strToU8(this.numberingXml()),
			"word/_rels/document.xml.rels": strToU8(
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
					'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
					this.rels.join("") +
					"</Relationships>",
			),
		};
		// Images are already compressed: storing them as is saves time.
		for (const [path, bytes] of Object.entries(this.media)) files[path] = [bytes, { level: 0 }];
		return new Blob([zipSync(files, { level: 6 })], { type: DOCX_MIME_TYPE });
	}
}

const CONTENT_TYPES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
	'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
	'<Default Extension="xml" ContentType="application/xml"/>' +
	'<Default Extension="png" ContentType="image/png"/>' +
	'<Default Extension="jpeg" ContentType="image/jpeg"/>' +
	'<Default Extension="gif" ContentType="image/gif"/>' +
	'<Default Extension="bmp" ContentType="image/bmp"/>' +
	'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
	'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
	'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
	'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
	"</Types>";

const ROOT_RELS =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
	'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
	"</Relationships>";

function headingStyle(level: number, size: number, extra: { border?: boolean; color?: string } = {}): string {
	return (
		`<w:style w:type="paragraph" w:styleId="Heading${level}">` +
		`<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
		'<w:uiPriority w:val="9"/><w:qFormat/>' +
		"<w:pPr><w:keepNext/><w:keepLines/>" +
		(extra.border ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D0D7DE"/></w:pBdr>' : "") +
		`<w:spacing w:before="${level <= 2 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
		`<w:rPr><w:b/><w:color w:val="${extra.color ?? "1F2328"}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
		"</w:style>"
	);
}

const STYLES =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
	'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
	"<w:docDefaults><w:rPrDefault><w:rPr>" +
	'<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
	'<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
	"</w:rPr></w:rPrDefault>" +
	'<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
	"</w:docDefaults>" +
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
	'<w:rPr><w:color w:val="1F2328"/></w:rPr></w:style>' +
	'<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">' +
	'<w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
	headingStyle(1, 36, { border: true }) +
	headingStyle(2, 30, { border: true }) +
	headingStyle(3, 26) +
	headingStyle(4, 24) +
	headingStyle(5, 22) +
	headingStyle(6, 22, { color: "59636E" }) +
	'<w:style w:type="paragraph" w:customStyle="1" w:styleId="SourceCode">' +
	'<w:name w:val="Source Code"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
	"<w:pPr><w:pBdr>" +
	'<w:top w:val="single" w:sz="4" w:space="6" w:color="F6F8FA"/>' +
	'<w:left w:val="single" w:sz="4" w:space="6" w:color="F6F8FA"/>' +
	'<w:bottom w:val="single" w:sz="4" w:space="6" w:color="F6F8FA"/>' +
	'<w:right w:val="single" w:sz="4" w:space="6" w:color="F6F8FA"/>' +
	'</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>' +
	'<w:spacing w:before="120" w:after="240" w:line="240" w:lineRule="auto"/></w:pPr>' +
	'<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>' +
	"</w:style>" +
	'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
	'<w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
	'<w:rPr><w:color w:val="0969DA"/><w:u w:val="single"/></w:rPr></w:style>' +
	"</w:styles>";

/**
 * Converts a markdown document into a .docx blob. Images are fetched in
 * parallel before the (synchronous) rendering of the body.
 */
export async function buildDocx(markdown: string, options: DocxOptions): Promise<Blob> {
	const tokens = marked.lexer(markdown);

	const hrefs = new Set<string>();
	marked.walkTokens(tokens, (token) => {
		if (token.type === "image" && token.href) hrefs.add(token.href);
	});
	const images = new Map<string, EmbeddedImage | null>();
	await Promise.all(
		[...hrefs].map(async (href) => {
			images.set(href, await loadImage(href, options));
		}),
	);

	const writer = new DocxWriter(images);
	const body = writer.blocks(tokens, { indent: 0, run: {}, listDepth: 0 });
	return writer.pack(body, options.title);
}
