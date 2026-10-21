import { Marked, type TokenizerAndRendererExtension } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Registers only a subset of common languages (a lighter bundle than the full
// "highlight.js" package). To add support for another language, import the
// corresponding module from "highlight.js/lib/languages/*" and register it
// below.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

/**
 * Pandoc-style subscript (`H~2~O`) and superscript (`x^2^`). As in Pandoc, the
 * content can't contain unescaped spaces (escape them as `\ `), so stray `~`/`^`
 * in prose are left alone. Double tildes (`~~text~~`) stay GFM strikethrough:
 * the subscript rule never matches `~~`.
 */
function scriptExtension(name: "sub" | "sup", delimiter: "~" | "^"): TokenizerAndRendererExtension {
	const d = `\\${delimiter}`;
	const rule = new RegExp(`^${d}(?!${d})((?:\\\\.|[^\\s${d}\\\\])+)${d}(?!${d})`);
	return {
		name,
		level: "inline",
		start(src) {
			const index = src.indexOf(delimiter);
			return index === -1 ? undefined : index;
		},
		tokenizer(src) {
			const match = rule.exec(src);
			if (!match) return undefined;
			// An escaped space (`\ `) stands for a literal space, as in Pandoc.
			const text = match[1].replace(/\\ /g, " ");
			return { type: name, raw: match[0], text, tokens: this.lexer.inlineTokens(text) };
		},
		renderer(token) {
			return `<${name}>${this.parser.parseInline(token.tokens ?? [])}</${name}>`;
		},
	};
}

/**
 * Highlighted text (`==very important words==`) rendered as `<mark>`. Like GFM
 * strikethrough, the content can contain spaces but can't start or end with
 * one, so `a == b` comparisons in prose are left alone.
 */
const highlightExtension: TokenizerAndRendererExtension = {
	name: "mark",
	level: "inline",
	start(src) {
		const index = src.indexOf("==");
		return index === -1 ? undefined : index;
	},
	tokenizer(src) {
		const match = /^==(?![\s=])((?:\\.|[^\\\n]|\n(?!\n))*?[^\s\\=])==(?!=)/.exec(src);
		if (!match) return undefined;
		return { type: "mark", raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
	},
	renderer(token) {
		return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
	},
};

const DEFINITION_LINE = /^ {0,3}:[ \t]+/;
// Lines that start another block construct can't be a term (a heading, list
// item, quote, fence, table row, HTML or indented code followed by `: ...`).
const NOT_A_TERM = /^(?: {4}|\t| {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|>|```|~~~|<|\|))/;
const CONTINUATION_INDENT = /^(?: {2,}|\t)/;

const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";
const isDefinition = (line: string | undefined) => line !== undefined && DEFINITION_LINE.test(line);
const isTerm = (line: string | undefined) =>
	line !== undefined && !isBlank(line) && !isDefinition(line) && !NOT_A_TERM.test(line);

/**
 * Definition lists (PHP Markdown Extra / Pandoc syntax):
 *
 *     Term
 *     : Definition
 *     : Another definition
 *         with an indented continuation line
 *
 * A blank line may separate a term from its definitions. A definition holding
 * several paragraphs (blank line followed by indented lines) is rendered as
 * blocks; a single-paragraph one stays tight, without a `<p>`.
 */
const definitionListExtension: TokenizerAndRendererExtension = {
	name: "definitionList",
	level: "block",
	tokenizer(src) {
		const lines = src.split("\n");
		// Index of the first definition line of a group whose term is at `index`.
		const groupDefinitionAt = (index: number) => {
			if (!isTerm(lines[index])) return -1;
			if (isDefinition(lines[index + 1])) return index + 1;
			if (isBlank(lines[index + 1]) && isDefinition(lines[index + 2])) return index + 2;
			return -1;
		};

		const items: { term: string; definitions: string[] }[] = [];
		let consumed = 0;
		let line = groupDefinitionAt(0);
		if (line === -1) return undefined;

		while (line !== -1) {
			const item = { term: lines[consumed].trim(), definitions: [] as string[] };
			while (isDefinition(lines[line])) {
				const body = [lines[line].replace(DEFINITION_LINE, "")];
				line++;
				while (line < lines.length) {
					const current = lines[line];
					if (isBlank(current)) {
						if (!CONTINUATION_INDENT.test(lines[line + 1] ?? "") || isBlank(lines[line + 1])) break;
						body.push("");
					} else if (isDefinition(current)) {
						break;
					} else if (CONTINUATION_INDENT.test(current)) {
						body.push(current.replace(/^(?: {1,4}|\t)/, ""));
					} else if (body[body.length - 1] !== "") {
						// Lazy continuation of the definition's paragraph.
						body.push(current);
					} else {
						break;
					}
					line++;
				}
				item.definitions.push(body.join("\n"));
				// Definitions of the same term may be separated by a blank line.
				if (isBlank(lines[line]) && isDefinition(lines[line + 1])) line++;
			}
			items.push(item);
			consumed = line;

			// Another term of the same list, possibly after blank lines.
			let next = line;
			while (isBlank(lines[next])) next++;
			line = groupDefinitionAt(next);
			if (line !== -1) consumed = next;
		}

		const raw = lines.slice(0, consumed).join("\n") + (consumed < lines.length ? "\n" : "");
		// Inline content goes through `lexer.inline`, which defers it until the
		// whole document is lexed so reference links defined later resolve.
		const lexed = items.map(({ term, definitions }) => ({
			term: this.lexer.inline(term),
			definitions: definitions.map((text) => {
				const blocks = /\n[ \t]*\n/.test(text.trim());
				return {
					blocks,
					tokens: blocks ? this.lexer.blockTokens(text.trim(), []) : this.lexer.inline(text.trim()),
				};
			}),
		}));
		return {
			type: "definitionList",
			raw,
			items: lexed,
			// Every nested token, flattened, so `walkTokens` reaches them all. A
			// getter: the inline arrays are only filled once lexing completes.
			get tokens() {
				return lexed.flatMap(({ term, definitions }) => [...term, ...definitions.flatMap((d) => d.tokens)]);
			},
		};
	},
	renderer(token) {
		let html = "<dl>\n";
		for (const item of token.items) {
			html += `<dt>${this.parser.parseInline(item.term)}</dt>\n`;
			for (const definition of item.definitions) {
				const content = definition.blocks
					? this.parser.parse(definition.tokens)
					: this.parser.parseInline(definition.tokens);
				html += `<dd>${content}</dd>\n`;
			}
		}
		return html + "</dl>\n";
	},
};

const ALERT_TYPES = {
	note: {
		title: "Note",
		icon: "M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
	},
	tip: {
		title: "Tip",
		icon: "M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z",
	},
	important: {
		title: "Important",
		icon: "M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
	},
	warning: {
		title: "Warning",
		icon: "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
	},
	caution: {
		title: "Caution",
		icon: "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
	},
} as const;

type AlertType = keyof typeof ALERT_TYPES;

const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/**
 * GitHub-style alerts: a blockquote whose first line is exactly one of
 * `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`
 * (case-insensitive). As on GitHub, a marker with no content after it stays a
 * regular blockquote.
 */
const alertExtension: TokenizerAndRendererExtension = {
	name: "alert",
	level: "block",
	start(src) {
		const match = /^ {0,3}>/m.exec(src);
		return match ? match.index : undefined;
	},
	tokenizer(src) {
		if (!/^ {0,3}>[ \t]?\[!(?:note|tip|important|warning|caution)\]/i.test(src)) return undefined;
		const quote = this.lexer.tokenizer.blockquote(src);
		if (!quote) return undefined;
		const match = ALERT_MARKER.exec(quote.text);
		if (!match) return undefined;
		const body = quote.text.slice(match[0].length);
		if (body.trim() === "") return undefined;
		return {
			type: "alert",
			raw: quote.raw,
			alertType: match[1].toLowerCase() as AlertType,
			tokens: this.lexer.blockTokens(body, []),
		};
	},
	renderer(token) {
		const type = token.alertType as AlertType;
		const { title, icon } = ALERT_TYPES[type];
		const svg = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${icon}"></path></svg>`;
		return (
			`<div class="markdown-alert markdown-alert-${type}">\n` +
			`<p class="markdown-alert-title">${svg}${title}</p>\n` +
			this.parser.parse(token.tokens ?? []) +
			"</div>\n"
		);
	},
};

// A dedicated `marked` instance (not the package's global export) so as not to
// affect any other consumers of "marked" in the app.
export const marked = new Marked(
	{ extensions: [scriptExtension("sub", "~"), scriptExtension("sup", "^"), highlightExtension, definitionListExtension, alertExtension] },
	markedHighlight({
		langPrefix: "hljs language-",
		highlight(code, lang) {
			// No language specified (```) or an unregistered language: leave the
			// code unchanged, without highlighting.
			const language = hljs.getLanguage(lang) ? lang : undefined;
			if (!language) return code;
			return hljs.highlight(code, { language }).value;
		},
	}),
);

/** Attribute carrying the 0-based source line of a top-level preview block. */
export const SOURCE_LINE_ATTR = "data-source-line";

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/**
 * Same output as `marked.parse`, but every top-level block element is tagged
 * with the line of the source where it starts. The scroll sync uses those
 * anchors to align the editor and the preview line by line instead of by
 * percentage, which drifts badly on long documents with images, code blocks
 * or tables.
 *
 * Each top-level token is rendered on its own and the attribute is injected in
 * its first opening tag: wrapping the blocks in extra elements would break the
 * typography styles that rely on direct children/siblings.
 */
export function renderMarkdown(text: string): string {
	const tokens = marked.lexer(text);
	const walkTokens = marked.defaults.walkTokens;
	if (walkTokens) marked.walkTokens(tokens, walkTokens);

	let line = 0;
	let html = "";
	for (const token of tokens) {
		const startLine = line;
		line += countNewlines(token.raw);
		if (token.type === "space" || token.type === "def") continue;

		// The reference-style links ([text][ref]) are resolved through the
		// `links` map of the token list: it has to travel with every slice.
		const single = Object.assign([token], { links: tokens.links }) as typeof tokens;
		const chunk = marked.parser(single);
		html += chunk.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 ${SOURCE_LINE_ATTR}="${startLine}"`);
	}
	return html;
}
