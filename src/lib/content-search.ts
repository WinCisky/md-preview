/**
 * Full-text search across the documents of the file tree, used by the
 * sidebar's advanced search. Pure functions, no DOM: the sidebar renders the
 * results, the editor uses the offsets to select the match.
 *
 * Matching is a case-insensitive substring search of the whole query. Results
 * are grouped by document and, inside a document, by line: a line holding the
 * query several times is a single entry with every occurrence highlighted.
 */

import { ROOT_ID, type FileNode } from "$lib/files-db";

/** A piece of a snippet; `match` pieces are rendered highlighted. */
export interface SnippetPart {
	text: string;
	match: boolean;
}

export interface LineMatch {
	/** 0-based line of the source. */
	line: number;
	/** Offsets in the whole document of the first occurrence on this line. */
	start: number;
	end: number;
	/** The line, cut around the occurrences, split into plain/match parts. */
	parts: SnippetPart[];
}

export interface DocumentResult {
	node: FileNode;
	/** Names of the folders leading to the file, outermost first. */
	path: string[];
	/** The file name split into plain/match parts. */
	nameParts: SnippetPart[];
	nameMatches: boolean;
	/** Total occurrences in the content. */
	matchCount: number;
	/** The first lines with an occurrence (at most `maxLinesPerDocument`). */
	lines: LineMatch[];
	/** Lines with an occurrence beyond those in `lines`. */
	moreLines: number;
}

export interface SearchOptions {
	maxLinesPerDocument?: number;
	/** Characters kept before the first occurrence of a line. */
	contextBefore?: number;
	/** Maximum length of a snippet. */
	snippetLength?: number;
}

/** Start offsets of every (non-overlapping) occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	if (!needle) return found;
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) return found;
		found.push(index);
		from = index + needle.length;
	}
}

/** Splits `text` into parts, flagging the ranges `[start, start + length)`. */
function split(text: string, starts: number[], length: number, offset = 0): SnippetPart[] {
	const parts: SnippetPart[] = [];
	let cursor = 0;
	for (const absolute of starts) {
		const start = Math.max(0, absolute - offset);
		const end = Math.min(text.length, start + length);
		if (end <= cursor) continue;
		if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false });
		parts.push({ text: text.slice(Math.max(start, cursor), end), match: true });
		cursor = end;
	}
	if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
	return parts;
}

function folderPath(node: FileNode, byId: Map<string, FileNode>): string[] {
	const path: string[] = [];
	const seen = new Set<string>();
	let current = byId.get(node.parentId);
	while (current && current.id !== ROOT_ID && !seen.has(current.id)) {
		seen.add(current.id);
		path.unshift(current.name);
		current = byId.get(current.parentId);
	}
	return path;
}

function lineSnippet(
	line: string,
	starts: number[],
	length: number,
	contextBefore: number,
	snippetLength: number,
): SnippetPart[] {
	// Leading indentation is noise in a one-line snippet.
	const indent = line.length - line.trimStart().length;
	let from = Math.max(indent, starts[0] - contextBefore);
	// Do not cut a word in half at the start when it can be avoided.
	if (from > indent) {
		const space = line.lastIndexOf(" ", from);
		if (space >= indent && starts[0] - space <= contextBefore * 2) from = space + 1;
	}
	const to = Math.min(line.length, Math.max(from + snippetLength, starts[0] + length));
	const parts = split(
		line.slice(from, to),
		starts.filter((start) => start < to),
		length,
		from,
	);
	if (from > indent) parts.unshift({ text: "…", match: false });
	if (to < line.length) parts.push({ text: "…", match: false });
	return parts;
}

/**
 * Searches `query` in the name and content of every file. `contentOf` lets
 * the caller substitute the live text of the file open in the editor, which
 * may be ahead of what was saved.
 */
export function searchDocuments(
	nodes: FileNode[],
	query: string,
	contentOf: (node: FileNode) => string = (node) => node.content,
	options: SearchOptions = {},
): DocumentResult[] {
	const { maxLinesPerDocument = 100, contextBefore = 24, snippetLength = 90 } = options;
	const needle = query.trim().toLowerCase();
	if (!needle) return [];

	const byId = new Map(nodes.map((node) => [node.id, node]));
	const results: DocumentResult[] = [];

	for (const node of nodes) {
		if (node.type !== "file") continue;
		const nameStarts = occurrences(node.name.toLowerCase(), needle);
		const content = contentOf(node);
		// Lowercasing can change the length of some characters (e.g. "İ"),
		// which would shift the offsets: fall back to a per-line search then.
		const lower = content.toLowerCase();
		const sameLength = lower.length === content.length;

		const lines: LineMatch[] = [];
		let matchCount = 0;
		let lineCount = 0;
		let lineStart = 0;
		const sourceLines = content.split("\n");
		for (let index = 0; index < sourceLines.length; index++) {
			const line = sourceLines[index];
			const lowerLine = sameLength
				? lower.slice(lineStart, lineStart + line.length)
				: line.toLowerCase();
			const starts = lowerLine.length === line.length ? occurrences(lowerLine, needle) : [];
			if (starts.length > 0) {
				matchCount += starts.length;
				lineCount++;
				if (lines.length < maxLinesPerDocument) {
					lines.push({
						line: index,
						start: lineStart + starts[0],
						end: lineStart + starts[0] + needle.length,
						parts: lineSnippet(line, starts, needle.length, contextBefore, snippetLength),
					});
				}
			}
			lineStart += line.length + 1;
		}

		if (nameStarts.length === 0 && matchCount === 0) continue;
		results.push({
			node,
			path: folderPath(node, byId),
			nameParts: split(node.name, nameStarts, needle.length),
			nameMatches: nameStarts.length > 0,
			matchCount,
			lines,
			moreLines: lineCount - lines.length,
		});
	}

	// Name matches first, then the documents mentioning the query the most.
	results.sort(
		(a, b) =>
			Number(b.nameMatches) - Number(a.nameMatches) ||
			b.matchCount - a.matchCount ||
			a.node.name.localeCompare(b.node.name),
	);
	return results;
}
