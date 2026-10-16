/**
 * Center-aligned scroll sync between the markdown textarea and the preview.
 *
 * The preview blocks carry the source line they start at (see
 * renderMarkdown). For each of them we know its vertical position in the
 * preview and, by measuring a hidden mirror of the textarea, the position of
 * the same line in the editor (soft wraps included). Those pairs form a
 * piecewise-linear map between the two panes: the point at the center of the
 * scrolled pane is mapped to the other one, which is scrolled so that the
 * mapped point sits at its own center.
 */

import { SOURCE_LINE_ATTR } from "$lib/markdown";

export interface AnchorMap {
	/** Strictly increasing y offsets (content coordinates) in the editor. */
	editor: number[];
	/** Matching y offsets in the preview. */
	preview: number[];
	/**
	 * Top of every source line in the editor (content coordinates, padding
	 * included), soft wraps accounted for. Lets the word highlight measure a
	 * single line instead of laying out the whole document again.
	 */
	lineTops: number[];
}

/** Text styles that influence how the textarea wraps and lays out lines. */
const MIRRORED_STYLES = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontVariant",
	"fontFeatureSettings",
	"fontStretch",
	"letterSpacing",
	"wordSpacing",
	"lineHeight",
	"textTransform",
	"textIndent",
	"tabSize",
	"wordBreak",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

/**
 * An invisible div that copies the textarea's width and text styles, so text
 * laid out inside it wraps exactly like in the textarea. The caller appends
 * the content, measures and removes it.
 */
export function createEditorMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
	const computed = getComputedStyle(textarea);
	const mirror = document.createElement("div");
	for (const property of MIRRORED_STYLES) {
		mirror.style[property] = computed[property];
	}
	Object.assign(mirror.style, {
		position: "absolute",
		top: "0",
		left: "-99999px",
		visibility: "hidden",
		boxSizing: "border-box",
		border: "0",
		width: `${textarea.clientWidth}px`,
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
	});
	return mirror;
}

/** Top of every source line inside the textarea (see AnchorMap.lineTops). */
function measureLineTops(textarea: HTMLTextAreaElement): number[] {
	const mirror = createEditorMirror(textarea);
	const sourceLines = textarea.value.split("\n");
	const markers: HTMLSpanElement[] = [];
	const fragment = document.createDocumentFragment();
	sourceLines.forEach((line, index) => {
		const marker = document.createElement("span");
		markers.push(marker);
		fragment.append(marker, index < sourceLines.length - 1 ? `${line}\n` : line);
	});
	mirror.append(fragment);

	document.body.append(mirror);
	const mirrorTop = mirror.getBoundingClientRect().top;
	const tops = markers.map((marker) => marker.getBoundingClientRect().top - mirrorTop);
	mirror.remove();
	return tops;
}

export function buildAnchorMap(
	textarea: HTMLTextAreaElement,
	preview: HTMLElement,
): AnchorMap {
	const previewTop = preview.getBoundingClientRect().top - preview.scrollTop;
	const blocks = Array.from(
		preview.querySelectorAll<HTMLElement>(`article > [${SOURCE_LINE_ATTR}]`),
	);
	const lineTops = measureLineTops(textarea);

	const map: AnchorMap = { editor: [0], preview: [0], lineTops };
	const push = (editorY: number, previewY: number) => {
		// Only strictly increasing pairs: a non-monotonic map (hidden blocks,
		// floats, …) could not be inverted for the preview → editor direction.
		if (!Number.isFinite(editorY) || !Number.isFinite(previewY)) return;
		const lastEditor = map.editor[map.editor.length - 1];
		const lastPreview = map.preview[map.preview.length - 1];
		if (editorY <= lastEditor || previewY <= lastPreview) return;
		map.editor.push(editorY);
		map.preview.push(previewY);
	};
	for (const block of blocks) {
		const line = Number(block.getAttribute(SOURCE_LINE_ATTR));
		const editorY = lineTops[line];
		if (editorY === undefined) continue;
		push(editorY, block.getBoundingClientRect().top - previewTop);
	}
	push(textarea.scrollHeight, preview.scrollHeight);
	return map;
}

/** Piecewise-linear interpolation of `x` from the `from` axis to the `to` axis. */
function interpolate(from: number[], to: number[], x: number): number {
	if (from.length < 2) return x;
	if (x <= from[0]) return to[0];
	const last = from.length - 1;
	if (x >= from[last]) return to[last];
	// Binary search for the segment containing x.
	let low = 0;
	let high = last;
	while (high - low > 1) {
		const mid = (low + high) >> 1;
		if (from[mid] <= x) low = mid;
		else high = mid;
	}
	const span = from[high] - from[low];
	const ratio = span > 0 ? (x - from[low]) / span : 0;
	return to[low] + ratio * (to[high] - to[low]);
}

/**
 * Converts the content anchors into pairs of scrollTop values: anchor `i` is
 * centered in both panes when the editor is at `editor[i]` and the preview at
 * `preview[i]`.
 *
 * Only anchors that both panes can actually center are kept (near the top or
 * the bottom a pane cannot scroll far enough), and the pairs are closed by
 * (0, 0) and (editorMax, previewMax). Interpolating between them gives a
 * strictly increasing, invertible map: the centers are exactly aligned
 * wherever that is possible, the ends ramp linearly so that top ⇔ top and
 * bottom ⇔ bottom, and syncing in the two directions uses the same map, so a
 * pane can never "bottom out" while the other still has room to scroll.
 */
function scrollPairs(
	map: AnchorMap,
	editor: HTMLElement,
	preview: HTMLElement,
): { editor: number[]; preview: number[] } {
	const editorMax = editor.scrollHeight - editor.clientHeight;
	const previewMax = preview.scrollHeight - preview.clientHeight;
	const editorHalf = editor.clientHeight / 2;
	const previewHalf = preview.clientHeight / 2;

	const pairs = { editor: [0], preview: [0] };
	for (let index = 0; index < map.editor.length; index++) {
		const editorTop = map.editor[index] - editorHalf;
		const previewTop = map.preview[index] - previewHalf;
		if (editorTop >= editorMax || previewTop >= previewMax) continue;
		if (editorTop <= pairs.editor[pairs.editor.length - 1]) continue;
		if (previewTop <= pairs.preview[pairs.preview.length - 1]) continue;
		pairs.editor.push(editorTop);
		pairs.preview.push(previewTop);
	}
	pairs.editor.push(editorMax);
	pairs.preview.push(previewMax);
	return pairs;
}

/**
 * The scrollTop the other pane needs so that its center shows the same
 * content as the center of `source` (see scrollPairs for the ends).
 */
export function syncedScrollTop(
	map: AnchorMap,
	editor: HTMLElement,
	preview: HTMLElement,
	sourceIsEditor: boolean,
): number {
	const source = sourceIsEditor ? editor : preview;
	const target = sourceIsEditor ? preview : editor;
	const sourceMax = source.scrollHeight - source.clientHeight;
	const targetMax = target.scrollHeight - target.clientHeight;
	if (sourceMax <= 0 || targetMax <= 0) return 0;

	const pairs = scrollPairs(map, editor, preview);
	const from = sourceIsEditor ? pairs.editor : pairs.preview;
	const to = sourceIsEditor ? pairs.preview : pairs.editor;
	const next = interpolate(from, to, Math.min(sourceMax, Math.max(0, source.scrollTop)));
	return Math.min(targetMax, Math.max(0, next));
}
