/**
 * Thinking Preview
 *
 * Three levels for every thinking block, cycled with **Ctrl+T**:
 *
 *   preview   the first 5 lines, then `... N more lines hidden (ctrl+t)` — the default
 *   full      the whole block
 *   hidden    one `Thinking...` line
 *
 * The visible part is a fixed head, so it never moves while the model is still streaming. There is
 * no state file, no flag, no env var and no command: the level lives for the run and the next
 * session starts at `preview` again.
 *
 * Display only: the model's context is untouched. `ctrl+t` is pi's reserved `app.thinking.toggle`,
 * so the extension intercepts the raw keypress and consumes it — pi's own toggle never runs and the
 * `hideThinkingBlock` setting stays untouched.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ThinkingView = "full" | "preview" | "hidden";

/** The order Ctrl+T walks, and the level a new run starts on. */
export const CYCLE: ThinkingView[] = ["preview", "full", "hidden"];

/** How many lines of reasoning the `preview` level keeps. */
export const VISIBLE_LINES = 5;

const HIDDEN_LABEL = "Thinking...";
const TOGGLE_KEY = "ctrl+t";
const TOGGLE_HINT = "ctrl+t";

/** The level Ctrl+T moves to next. */
export function nextView(view: ThinkingView): ThinkingView {
	const index = CYCLE.indexOf(view);
	return CYCLE[(index + 1) % CYCLE.length];
}

/**
 * The `view` level's rendering of one thinking block.
 *
 * `full` returns the block untouched and `hidden` replaces it with a single label line. In
 * `preview`, blank separators are not reasoning: they are not spent from the budget and not counted
 * as hidden, so the hint says exactly how much was dropped — while blanks inside the head are kept,
 * so paragraphs and lists keep their shape. A block that fits is returned untouched, hint and all.
 */
export function promptThinking(
	markdown: string,
	view: ThinkingView,
	maxLines: number = VISIBLE_LINES,
): string {
	if (view === "full") return markdown;
	if (view === "hidden") return HIDDEN_LABEL;

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
	// The blank line keeps the hint out of the last kept paragraph, so it renders on its own line.
	return `${head}\n\n... ${hidden} more line${hidden === 1 ? "" : "s"} hidden (${TOGGLE_HINT})`;
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
	let view: ThinkingView = CYCLE[0];
	let stopInput: (() => void) | null = null;

	// pi runs transformers over every assistant markdown part — the answer text included — so the
	// thinking gate is what keeps levels out of the response body.
	pi.registerMarkdownTransformer((markdown, context) =>
		isThinkingContext(context) ? promptThinking(markdown, view) : markdown,
	);

	pi.on("session_start", async (_event, ctx) => {
		// pi fires session_start again on a session switch, so drop the old subscription first —
		// two live handlers would advance two levels per keypress.
		stopInput?.();
		stopInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, TOGGLE_KEY)) return undefined;
			view = nextView(view);
			// The UI API has no redraw entry point; the no-argument setHiddenThinkingLabel() is
			// the call pi makes after a settings reload, and it re-renders every message, which
			// re-runs the transformers over the already-rendered blocks.
			ctx.ui.setHiddenThinkingLabel();
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		stopInput?.();
		stopInput = null;
	});
}