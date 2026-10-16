/**
 * "Follow the scroll" highlight: the word closest to the center of the
 * preview is highlighted there and, at the same time, in the markdown source,
 * so the eye can match the two panes while they scroll.
 *
 * The word is always picked in the preview (the rendered text is what reads
 * naturally) and then mapped back to the source through the preview block it
 * belongs to: its `data-source-line` bounds the source range, and the word is
 * matched there by occurrence (the 3rd "foo" of the block in the preview is
 * the 3rd whole-word "foo" of the block's source). Markdown syntax rarely
 * contains words, so this is accurate in practice; URLs repeating a word of
 * their link text are the typical, harmless, exception.
 */

import { SOURCE_LINE_ATTR } from "$lib/markdown";
import { createEditorMirror } from "$lib/scroll-sync";

/** A box in the coordinates of the pane wrapper the highlight is drawn in. */
export interface Box {
	top: number;
	left: number;
	width: number;
	height: number;
}

export interface CenterWord {
	word: string;
	/** Viewport rect of the word in the preview. */
	rect: DOMRect;
	block: HTMLElement;
	/** How many whole-word occurrences of `word` precede it in the block. */
	occurrence: number;
}

export interface SourceWord {
	line: number;
	column: number;
	length: number;
}

const WORD = /[\p{L}\p{N}_]+/gu;
// Short words ("a", "of", "1") are poor landmarks: preferred only when the
// center line has nothing longer.
const MIN_PREFERRED_LENGTH = 3;
// Text nodes examined on each side of the one at the center.
const NODE_NEIGHBORHOOD = 12;
// Words examined on each side of the one found by binary search in a node.
const WORD_NEIGHBORHOOD = 40;

interface Candidate {
	node: Text;
	index: number;
	word: string;
	rect: DOMRect;
}

const range = typeof document !== "undefined" ? document.createRange() : null;

function rectOf(node: Text, start: number, end: number): DOMRect | null {
	if (!range) return null;
	range.setStart(node, start);
	range.setEnd(node, end);
	// The first box: a word broken across two lines is still one landmark.
	const rect = range.getClientRects()[0] ?? null;
	return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function nodeRect(node: Text): DOMRect | null {
	if (!range) return null;
	range.selectNodeContents(node);
	const rect = range.getBoundingClientRect();
	return rect.width > 0 || rect.height > 0 ? rect : null;
}

/** Distance of `y` from the vertical extent of `rect` (0 when inside). */
function verticalDistance(rect: DOMRect, y: number): number {
	if (y < rect.top) return rect.top - y;
	if (y > rect.bottom) return y - rect.bottom;
	return 0;
}

/**
 * Index of the first item whose rect does not end above `y`. Text flows top
 * to bottom, so the rects are (loosely) ordered and a binary search keeps the
 * per-frame cost independent of the size of the block.
 */
function searchByY<T>(items: T[], y: number, rect: (item: T) => DOMRect | null): number {
	let low = 0;
	let high = items.length - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		const box = rect(items[mid]);
		if (box && box.bottom < y) low = mid + 1;
		else high = mid;
	}
	return low;
}

function candidatesInNode(node: Text, y: number): Candidate[] {
	const text = node.data;
	const matches = Array.from(text.matchAll(WORD));
	if (matches.length === 0) return [];
	const center = searchByY(matches, y, (match) =>
		rectOf(node, match.index, match.index + match[0].length),
	);
	const candidates: Candidate[] = [];
	const from = Math.max(0, center - WORD_NEIGHBORHOOD);
	const to = Math.min(matches.length - 1, center + WORD_NEIGHBORHOOD);
	for (let index = from; index <= to; index++) {
		const match = matches[index];
		const rect = rectOf(node, match.index, match.index + match[0].length);
		if (rect) candidates.push({ node, index: match.index, word: match[0], rect });
	}
	return candidates;
}

function textNodesOf(block: HTMLElement): Text[] {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node as Text);
	}
	return nodes;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWord(word: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "gu");
}

/** The word closest to the center of the visible preview, or null. */
export function findCenterWord(preview: HTMLElement): CenterWord | null {
	const paneRect = preview.getBoundingClientRect();
	const centerY = paneRect.top + preview.clientTop + preview.clientHeight / 2;
	const centerX = paneRect.left + preview.clientLeft + preview.clientWidth / 2;

	const blocks = Array.from(
		preview.querySelectorAll<HTMLElement>(`article > [${SOURCE_LINE_ATTR}]`),
	);
	if (blocks.length === 0) return null;
	const blockIndex = searchByY(blocks, centerY, (block) => block.getBoundingClientRect());

	// The center can fall in the margin between two blocks: look at both.
	let best: Candidate | null = null;
	let bestBlock: HTMLElement | null = null;
	let bestScore = Infinity;
	for (const block of [blocks[blockIndex - 1], blocks[blockIndex]]) {
		if (!block) continue;
		const nodes = textNodesOf(block).filter((node) => /[\p{L}\p{N}_]/u.test(node.data));
		if (nodes.length === 0) continue;
		const nodeIndex = searchByY(nodes, centerY, nodeRect);
		const from = Math.max(0, nodeIndex - NODE_NEIGHBORHOOD);
		const to = Math.min(nodes.length - 1, nodeIndex + NODE_NEIGHBORHOOD);
		for (let index = from; index <= to; index++) {
			for (const candidate of candidatesInNode(nodes[index], centerY)) {
				// Closest line first, then longer words, then closest to the
				// horizontal middle of the pane.
				const dy = Math.round(verticalDistance(candidate.rect, centerY));
				const short = candidate.word.length < MIN_PREFERRED_LENGTH ? 1 : 0;
				const dx = Math.abs((candidate.rect.left + candidate.rect.right) / 2 - centerX);
				const score = dy * 1e6 + short * 1e5 + dx;
				if (score < bestScore) {
					bestScore = score;
					best = candidate;
					bestBlock = block;
				}
			}
		}
	}
	if (!best || !bestBlock) return null;

	// Rendered text of the block up to the word: it decides which occurrence
	// of the word this is.
	let before = "";
	for (const node of textNodesOf(bestBlock)) {
		if (node === best.node) {
			before += node.data.slice(0, best.index);
			break;
		}
		before += node.data;
	}
	const occurrence = before.match(wholeWord(best.word))?.length ?? 0;
	return { word: best.word, rect: best.rect, block: bestBlock, occurrence };
}

/** Where the preview word lives in the markdown source, or null. */
export function locateInSource(text: string, found: CenterWord): SourceWord | null {
	const lines = text.split("\n");
	const startLine = Number(found.block.getAttribute(SOURCE_LINE_ATTR));
	let endLine = lines.length;
	for (
		let next = found.block.nextElementSibling;
		next;
		next = next.nextElementSibling
	) {
		const line = next.getAttribute(SOURCE_LINE_ATTR);
		if (line !== null) {
			endLine = Number(line);
			break;
		}
	}
	if (!Number.isFinite(startLine) || startLine >= lines.length) return null;

	const segment = lines.slice(startLine, Math.max(startLine + 1, endLine)).join("\n");
	const matches = Array.from(segment.matchAll(wholeWord(found.word)));
	if (matches.length === 0) return null;
	const match = matches[Math.min(found.occurrence, matches.length - 1)];

	const preceding = segment.slice(0, match.index);
	const lineOffset = preceding.split("\n").length - 1;
	const column = match.index - (preceding.lastIndexOf("\n") + 1);
	return { line: startLine + lineOffset, column, length: found.word.length };
}

/**
 * Box of a source word inside the textarea, in the coordinates of the
 * textarea's offsetParent; null when it is scrolled out of view.
 */
export function editorWordBox(
	textarea: HTMLTextAreaElement,
	lineTops: number[],
	source: SourceWord,
): Box | null {
	const lineTop = lineTops[source.line];
	const lineText = textarea.value.split("\n")[source.line];
	if (lineTop === undefined || lineText === undefined) return null;

	// Only this one line is laid out: its top is already known, and a line
	// wraps independently of the others.
	const mirror = createEditorMirror(textarea);
	mirror.style.paddingTop = "0";
	mirror.style.paddingBottom = "0";
	// `lineTop` was measured on an empty marker at the start of the line, i.e.
	// at the top of the text's inline box, already below the line box top by
	// the half-leading. Measuring the word against the same kind of marker
	// keeps that offset counted once, so the box wraps the glyphs instead of
	// sliding down by the half-leading.
	const lineStart = document.createElement("span");
	const marker = document.createElement("span");
	marker.textContent = lineText.slice(source.column, source.column + source.length);
	mirror.append(
		lineStart,
		lineText.slice(0, source.column),
		marker,
		lineText.slice(source.column + source.length),
	);
	document.body.append(mirror);
	const mirrorRect = mirror.getBoundingClientRect();
	const lineStartTop = lineStart.getBoundingClientRect().top;
	const rect = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
	mirror.remove();

	const top =
		textarea.offsetTop + textarea.clientTop + lineTop + (rect.top - lineStartTop) - textarea.scrollTop;
	const left =
		textarea.offsetLeft + textarea.clientLeft + (rect.left - mirrorRect.left) - textarea.scrollLeft;
	const viewTop = textarea.offsetTop + textarea.clientTop;
	if (top + rect.height <= viewTop || top >= viewTop + textarea.clientHeight) return null;
	return { top, left, width: rect.width, height: rect.height };
}

/** `rect` (viewport coordinates) relative to `container`. */
export function boxWithin(rect: DOMRect, container: HTMLElement): Box {
	const origin = container.getBoundingClientRect();
	return {
		top: rect.top - origin.top,
		left: rect.left - origin.left,
		width: rect.width,
		height: rect.height,
	};
}
