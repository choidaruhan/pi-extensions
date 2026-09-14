/**
 * Thinking Preview
 *
 * Every thinking block renders its **first 5 lines**, a `... N more lines hidden` hint, and
 * nothing else. Reasoning stays visible without pushing the conversation off the screen, and
 * because the visible part is a fixed head it never moves while the model is still streaming.
 *
 * Display only: the model's context is untouched, nothing is written to disk, and no key or
 * command is registered — pi's own Ctrl+T still folds every block away if you want that.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How many lines of a thinking block stay on screen. */
export const VISIBLE_LINES = 5;

/**
 * The first `maxLines` lines of reasoning, then a hint counting the lines left out.
 *
 * Blank separators are not reasoning: they are not spent from the budget and not counted as
 * hidden, so the hint says exactly how much was dropped. Blank lines inside the visible part
 * are kept, so paragraphs and lists keep their shape. A block that fits is returned untouched.
 */
export function previewThinking(
	markdown: string,
	maxLines: number = VISIBLE_LINES,
): string {
	const text = markdown.replace(/\s+$/, "");
	if (text === "" || maxLines <= 0) return text;

	const lines = text.split("\n");
	const kept: string[] = [];
	let taken = 0;
	let index = 0;
	for (; index < lines.length && taken < maxLines; index++) {
		if (lines[index].trim() !== "") taken++;
		kept.push(lines[index]);
	}

	const hidden = lines
		.slice(index)
		.filter((line) => line.trim() !== "").length;
	if (hidden === 0) return text;

	const head = kept.join("\n").replace(/\s+$/, "");
	// The blank line keeps the hint out of the final paragraph, so it renders on its own line.
	return `${head}\n\n... ${hidden} more line${hidden === 1 ? "" : "s"} hidden`;
}

/** pi marks thinking parts as "assistant-thinking"; older builds used `kind`. */
export function isThinkingContext(context: {
	messageType?: string;
	kind?: string;
}): boolean {
	return (
		context.messageType === "assistant-thinking" || context.kind === "thinking"
	);
}

export default function (pi: ExtensionAPI) {
	// pi runs transformers over every assistant markdown part — the answer text included —
	// so the thinking gate is what keeps previews out of the response body.
	pi.registerMarkdownTransformer((markdown, context) =>
		isThinkingContext(context) ? previewThinking(markdown) : markdown,
	);
}
