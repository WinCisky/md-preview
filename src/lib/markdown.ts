import { Marked } from "marked";
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

// A dedicated `marked` instance (not the package's global export) so as not to
// affect any other consumers of "marked" in the app.
export const marked = new Marked(
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
