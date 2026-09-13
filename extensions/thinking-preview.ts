/**
 * Thinking Preview Extension
 *
 * Gives thinking blocks three display levels instead of pi's built-in two, and
 * cycles them with Ctrl+T:
 *
 *   1. full     every line of the block
 *   2. preview  the last `N` rows of the block, with a `... (X earlier lines, ctrl+t)`
 *               hint on its own row above them (default level). The hint and the blank row
 *               under it are extra: N counts reasoning rows only. Rows are counted by pi's own
 *               markdown renderer, so a line the terminal wraps costs the several rows it
 *               fills and a budget that ends mid-line shows the tail of that line; blank
 *               separators inside the block are dropped so every row below the hint is a row of
 *               reasoning.
 *   3. hidden   a single muted `Thinking...` line, nothing else
 *
 * Defaults:
 *   level = preview, N = 5 rows of reasoning (the hint row is extra)
 *   Override at load time with PI_THINKING_PREVIEW_VIEW=<full|preview|hidden>
 *   and/or PI_THINKING_PREVIEW_LINES=<n>, or per run with --thinking-preview=<value>.
 *   Hint text: PI_THINKING_PREVIEW_HINT="<text>", hidden label: PI_THINKING_HIDDEN_LABEL.
 *
 * Commands:
 *   /thinking-preview            show the current level
 *   /thinking-preview <n>        preview the last <n> rows (1-500)
 *   /thinking-preview full       show whole thinking blocks (alias: off, all)
 *   /thinking-preview preview    back to the N-line preview (alias: on)
 *   /thinking-preview hidden     hide thinking blocks (alias: hide)
 *
 * Notes / SAFETY:
 *   - Rendered output only: model context is never touched, nothing is executed,
 *     no network access. The single write is this extension's own state file
 *     (~/.pi/agent/thinking-preview.json, or $PI_CODING_AGENT_DIR).
 *   - Ctrl+T is a pi-reserved keybinding ("app.thinking.toggle"), so extensions
 *     cannot claim it with pi.registerShortcut. This extension instead
 *     intercepts the raw keypress through ctx.ui.onTerminalInput() and consumes
 *     it, which also stops pi's built-in toggle from setting
 *     `hideThinkingBlock` behind our back. The built-in setting therefore stays
 *     false and this extension owns thinking visibility.
 *   - Pi reads `hideThinkingBlock` once at session start. If a settings layer
 *     still has it enabled, the renderer takes a Text() path that never consults
 *     markdown transformers, so the preview cannot run; the extension warns at
 *     session start and the command reports it.
 */

import {
	getMarkdownTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Height of the default preview block in rendered rows: the hint row plus four rows of
 * reasoning. Budgets below 2 leave no room for the hint (see truncateThinking).
 */
const DEFAULT_PREVIEW_LINES = 5;
const MAX_PREVIEW_LINES = 500;

/** Display levels, in cycle order: Ctrl+T walks full -> preview -> hidden -> full. */
export type ThinkingView = "full" | "preview" | "hidden";
export const THINKING_VIEWS: readonly ThinkingView[] = [
	"full",
	"preview",
	"hidden",
] as const;

export interface ThinkingState {
	view: ThinkingView;
	/** Tail size used by the "preview" level. */
	lines: number;
}

export const DEFAULT_STATE: ThinkingState = {
	view: "preview",
	lines: DEFAULT_PREVIEW_LINES,
};

/** The key that cycles levels (pi's own "app.thinking.toggle" binding). */
const TOGGLE_KEY = "ctrl+t";
const HINT_KEY = "ctrl+t";

/** Key part of the hint shown above a truncated block (full hint is built per block). */
const DEFAULT_EXPAND_HINT = `${HINT_KEY} to cycle`;
/** Label rendered for the "hidden" level (matches pi's own default). */
const DEFAULT_HIDDEN_LABEL = "Thinking...";

const AGENT_DIR = join(
	process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? "", ".pi", "agent"),
	"",
).replace(/\/$/, "");
const STATE_PATH = join(AGENT_DIR, "thinking-preview.json");

function clampLines(value: number): number {
	return Math.max(0, Math.min(value, MAX_PREVIEW_LINES));
}

function isView(value: unknown): value is ThinkingView {
	return THINKING_VIEWS.includes(value as ThinkingView);
}

/**
 * Parse a level spec shared by the CLI flag, the env var and the command:
 * a view name, or a line count (0 = hidden, n >= 1 = preview with n lines).
 */
export function parseViewSpec(raw: string): ThinkingState | null {
	const value = raw.trim().toLowerCase();
	if (value === "") return null;
	if (isView(value)) return { view: value, lines: DEFAULT_STATE.lines };
	if (value === "all" || value === "off" || value === "show")
		return { view: "full", lines: DEFAULT_STATE.lines };
	if (value === "on") return { view: "preview", lines: DEFAULT_STATE.lines };
	if (value === "hide" || value === "none") return { view: "hidden", lines: 0 };
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	const lines = clampLines(parsed);
	// "0 lines" is the hidden level; the tail size stays independent of the level so
	// returning to "preview" restores whatever N the user had.
	return lines === 0
		? { view: "hidden", lines: DEFAULT_STATE.lines }
		: { view: "preview", lines };
}

/** The level chosen by the user, remembered across /reload and new sessions. */
export function loadSavedState(): ThinkingState | null {
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
			view?: unknown;
			lines?: unknown;
			/** Older versions stored only this key. */
			previewLines?: unknown;
		};
		const rawLines = parsed.lines ?? parsed.previewLines;
		const lines =
			typeof rawLines === "number" && Number.isFinite(rawLines)
				? clampLines(rawLines)
				: DEFAULT_STATE.lines;
		const tailLines = lines === 0 ? DEFAULT_STATE.lines : lines;
		if (isView(parsed.view)) return { view: parsed.view, lines: tailLines };
		// Pre-view state files meant "tail preview with N lines", and a saved 0 meant "no
		// truncation" (the old /thinking-preview off), which is now the full level.
		if (rawLines !== undefined)
			return lines === 0
				? { view: "full", lines: DEFAULT_STATE.lines }
				: { view: "preview", lines: tailLines };
	} catch {
		// No saved state yet: fall back to the caller's default.
	}
	return null;
}

/** Persist the level so /reload and the next session start from the same value. */
export function saveState(state: ThinkingState): void {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		// Best effort only: a read-only home must not break the command.
	}
}

/** Saved state, then env override, then the built-in default. */
export function resolveInitialState(
	env: Record<string, string | undefined> = process.env,
): ThinkingState {
	const saved = loadSavedState() ?? DEFAULT_STATE;
	const fromView = env.PI_THINKING_PREVIEW_VIEW;
	const fromLines = env.PI_THINKING_PREVIEW_LINES;
	if (fromView !== undefined && fromView.trim() !== "") {
		const spec = parseViewSpec(fromView);
		if (spec !== null) return { ...spec, lines: saved.lines };
	}
	if (fromLines !== undefined && fromLines.trim() !== "") {
		const parsed = Number.parseInt(fromLines, 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			const lines = clampLines(parsed);
			return {
				view: lines === 0 ? "hidden" : "preview",
				lines: lines === 0 ? DEFAULT_STATE.lines : lines,
			};
		}
	}
	return saved;
}

/** The level Ctrl+T moves to next. */
export function nextView(view: ThinkingView): ThinkingView {
	const index = THINKING_VIEWS.indexOf(view);
	return THINKING_VIEWS[(index + 1) % THINKING_VIEWS.length];
}

/**
 * Read pi's own hideThinkingBlock setting straight from the settings layers
 * (project overrides global). The extension API exposes no getter, and when the
 * setting is true the renderer takes a Text() path that never consults markdown
 * transformers, so the preview would silently do nothing.
 */
export function hideThinkingBlockEnabled(cwd = process.cwd()): boolean {
	const layers = [
		join(cwd, ".pi", "settings.json"),
		join(process.env.HOME ?? "", ".pi", "agent", "settings.json"),
	];
	for (const path of layers) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				hideThinkingBlock?: unknown;
			};
			if (typeof parsed.hideThinkingBlock === "boolean")
				return parsed.hideThinkingBlock;
		} catch {
			// Missing or malformed layer: fall through to the next one.
		}
	}
	return false;
}

/** Shown when the built-in "hide" wins over this extension. */
function hiddenWarning(): string {
	return "thinking-preview: hideThinkingBlock=true 라 추론 블록이 통째로 접혀 이 확장이 그릴 수 없습니다. ~/.pi/agent/settings.json 에서 hideThinkingBlock을 false로 바꾸고 /reload 하세요.";
}

/**
 * Force every already-rendered assistant message to re-render.
 *
 * The extension UI API has no redraw entry point, but `setHiddenThinkingLabel`
 * is one: pi's implementation (interactive-mode.js:1683) resolves a missing label
 * to its own default and then calls `updateContent` on every
 * AssistantMessageComponent in the transcript plus the streaming component, which
 * re-runs the markdown transformers. The no-argument form is the same call pi
 * itself makes after a settings reload.
 */
function refreshTranscript(ui: {
	setHiddenThinkingLabel: (label?: string) => void;
}): void {
	ui.setHiddenThinkingLabel();
}

/** Hint text; override without editing code via PI_THINKING_PREVIEW_HINT. */
export function expandHint(): string {
	const raw = process.env.PI_THINKING_PREVIEW_HINT;
	return raw !== undefined && raw.trim() !== ""
		? raw.trim()
		: DEFAULT_EXPAND_HINT;
}

/** Label used for the "hidden" level; override via PI_THINKING_HIDDEN_LABEL. */
export function hiddenLabel(): string {
	const raw = process.env.PI_THINKING_HIDDEN_LABEL;
	return raw !== undefined && raw.trim() !== ""
		? raw.trim()
		: DEFAULT_HIDDEN_LABEL;
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

/**
 * Build the markdown transformer the extension registers.
 *
 * pi runs the transformer list over EVERY assistant markdown part — the final
 * answer text included — so the thinking gate below is what keeps previews out of
 * the response body. It is also what makes this factory (rather than a raw arrow
 * function) the thing tests exercise.
 */
export function createThinkingTransformer(getState: () => ThinkingState): (
	markdown: string,
	context: {
		messageType?: string;
		kind?: string;
		isStreaming: boolean;
		availableWidth?: number;
	},
) => string {
	return (markdown, context) => {
		if (!isThinkingContext(context)) return markdown;
		const state = getState();

		if (state.view === "hidden") return hiddenLabel();
		if (state.view === "full") return markdown;

		return truncateThinking(markdown, state.lines, {
			// pi passes the markdown content width, which is exactly the wrap width it
			// renders the transformer's output with, so row counts here match the screen.
			width: context.availableWidth,
		});
	};
}

/** Columns pi spends on a blockquote border ("│ ") per nesting level. */
const QUOTE_COLUMNS = 2;
/** Columns pi spends per list nesting level (its renderer indents 4 per depth). */
const LIST_INDENT_COLUMNS = 4;

const QUOTE_PREFIX = /^\s*>\s?/;
const LIST_PREFIX = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)/;

export interface LinePrefix {
	/** Markdown that must stay in front of the content when a line is cut mid-way. */
	prefix: string;
	/** Content after that prefix, which is what pi actually wraps. */
	body: string;
	/** Columns the prefix eats from the wrap width. */
	columns: number;
}

/**
 * Split a source line into the markdown pi renders in front of wrapped content
 * (blockquote borders, list indentation and marker) and the content itself.
 *
 * pi's markdown renderer wraps an item's content at `width - prefixWidth` and then
 * puts the prefix back in front of every wrapped row (markdown.js:427 for quotes,
 * markdown.js:591-615 for lists), so the same subtraction has to happen here for a
 * row count to match what is on screen. `depth` is the list nesting level the caller
 * resolved for this line (0 = top level).
 */
export function splitLinePrefix(line: string, depth = 0): LinePrefix {
	let prefix = "";
	let columns = 0;
	let rest = line;
	for (;;) {
		const quote = QUOTE_PREFIX.exec(rest);
		if (quote === null) break;
		prefix += quote[0];
		columns += QUOTE_COLUMNS;
		rest = rest.slice(quote[0].length);
	}
	const list = LIST_PREFIX.exec(rest);
	if (list !== null) {
		prefix += rest.slice(0, list[0].length);
		columns += depth * LIST_INDENT_COLUMNS + visibleWidth(`${list[2]} `);
		rest = rest.slice(list[0].length);
		// pi adds a task marker in front of the content of checkbox items (markdown.js:601).
		const task = /^\[[ xX]\][ \t]+/.exec(rest);
		if (task !== null) {
			prefix += task[0];
			columns += visibleWidth(task[0]);
			rest = rest.slice(task[0].length);
		}
	}
	return { prefix, body: rest, columns };
}

export interface LineRow {
	/** Rows this line occupies on screen once pi wraps it (a blank line still renders one). */
	rows: number;
	/** Rows this line costs the preview budget: 0 for the blank separators between parts. */
	contentRows: number;
	/** Whether the line's own text may be cut mid-way (false for fence markers). */
	sliceable: boolean;
	/** List nesting level pi renders this line at (0 = not in a list). */
	depth: number;
	/** Inside a fenced code block (markers included). */
	fenced: boolean;
	/** The line is a ``` / ~~~ fence marker (never shown on its own). */
	marker: boolean;
}

const FENCE = /^\s*(```|~~~)/;
/** pi renders a fence marker row plus one empty row after it. */
const FENCE_OPEN_ROWS = 2;
/** A heading or a thematic break always ends the paragraph in front of it. */
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK =
	/^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** An ordered marker only interrupts an open paragraph when it starts at 1 (markdown-it). */
const ORDERED_MARKER = /^\s{0,3}(\d{1,9})[.)][ \t]+/;

/**
 * The text pi puts on screen for one line of markdown: inline markup is consumed by the
 * renderer, so backticks, emphasis markers and link targets never reach the terminal and
 * never take up columns. Wrapping happens on this text, not on the source line, which is
 * why a line full of `code spans` wraps earlier here than its source length suggests.
 */
export function markdownPlain(line: string): string {
	return line
		.replace(/`+([^`]*)`+/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\\([\\`*_{}[\]()#+.!|>~-])/g, "$1")
		.replace(/(\*\*\*|___|\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
		.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "$1");
}

/**
 * The fallback row model: how many rows each source line occupies at `width`.
 *
 * `countRenderedRows` measures with pi's own renderer whenever it can and falls back to this
 * model only when that renderer is unavailable, so this stays a model of pi's markdown rather
 * than the authority on it.
 *
 * `width <= 0` means "no wrapping information": every non-blank line counts as one row,
 * which is the line-based behaviour of earlier versions. List nesting is resolved the way
 * markdown does it — relative to the enclosing item's content column — so `  - a` inside a
 * top-level item is one level deep, exactly as pi renders it.
 */
export function measureLines(lines: string[], width: number): LineRow[] {
	const levels: { depth: number; content: number }[] = [];
	/** Content column of the paragraph the previous line left open, or -1 when none is open. */
	let paragraph = -1;
	/** Whether the previous line was a blank separator (a blockquote adds no row after one). */
	let previousBlank = true;
	/** Whether the previous line was itself a blockquote line (only the first one adds a row). */
	let previousQuote = false;
	let inFence = false;

	return lines.map((line, index) => {
		const blank = line.trim() === "";
		const followedBlank = previousBlank;
		const quote = QUOTE_PREFIX.test(line);
		const startsQuote = quote && !previousQuote;
		previousBlank = blank;
		previousQuote = quote;
		if (!(width > 0)) {
			const marker = FENCE.test(line);
			return {
				// Without a width there is no wrapping to model, so one row is one source line; a
				// blank separator still occupies the row it sits on in the final render. Fence
				// markers stay markers here too, so a tail never starts on a bare fence.
				rows: 1,
				contentRows: blank ? 0 : 1,
				sliceable: false,
				depth: 0,
				fenced: marker,
				marker,
			};
		}

		if (FENCE.test(line)) {
			levels.length = 0;
			paragraph = -1;
			if (!inFence) {
				inFence = true;
				return {
					rows: FENCE_OPEN_ROWS,
					contentRows: FENCE_OPEN_ROWS,
					sliceable: false,
					depth: 0,
					fenced: true,
					marker: true,
				};
			}
			inFence = false;
			return {
				rows: 1,
				contentRows: 1,
				sliceable: false,
				depth: 0,
				fenced: true,
				marker: true,
			};
		}
		if (inFence) {
			const rows = wrapTextWithAnsi(line, width).length;
			return {
				rows,
				contentRows: rows,
				sliceable: true,
				depth: 0,
				fenced: true,
				marker: false,
			};
		}

		const list = LIST_PREFIX.exec(line);
		const ordered = ORDERED_MARKER.exec(line);
		// An ordered marker other than "1." cannot interrupt an open paragraph: markdown keeps
		// the line inside that paragraph, so it is wrapped at the paragraph's column rather
		// than as a list item. Bullets and "1." always start their own list.
		const listStart =
			list !== null && (paragraph < 0 || ordered === null || ordered[1] === "1");
		let depth = 0;
		let body = line;
		let columns = 0;
		if (blank) {
			paragraph = -1;
		} else if (listStart) {
			const indent = list[1].length;
			while (levels.length > 0 && levels[levels.length - 1].content > indent)
				levels.pop();
			depth = levels.length === 0 ? 0 : levels[levels.length - 1].depth + 1;
			levels.push({ depth, content: indent + list[0].length });
			({ body, columns } = splitLinePrefix(line, depth));
			paragraph = columns;
		} else if (
			paragraph >= 0 &&
			!HEADING.test(line) &&
			!THEMATIC_BREAK.test(line) &&
			// A blockquote marker opens its own block instead of continuing the paragraph.
			!QUOTE_PREFIX.test(line)
		) {
			// A plain line inside an open paragraph is a lazy continuation: markdown keeps it in
			// that paragraph (inside a list item, inside a blockquote), so pi indents it to the
			// paragraph's column and wraps it at the same reduced width. Only the columns the
			// paragraph already owns are consumed: whitespace past the paragraph's content
			// column stays in the line, and pi wraps it as text (a line 2 columns from the wrap
			// boundary is one row taller here than `line.trim()` would have it).
			const indent = line.length - line.trimStart().length;
			columns = paragraph;
			body = line.slice(Math.min(indent, paragraph)).replace(/\s+$/, "");
		} else {
			levels.length = 0;
			({ body, columns } = splitLinePrefix(line, 0));
			paragraph = columns;
		}

		const rows = blank
			? 1
			: wrapTextWithAnsi(markdownPlain(body), Math.max(1, width - columns)).length;
		// pi renders a blockquote as its own block, separated from the text above it by one empty
		// row, so a quote that does not open the preview costs a row the source does not show.
		const quoteRow = !blank && index > 0 && !followedBlank && startsQuote ? 1 : 0;
		return {
			rows: rows + quoteRow,
			// A blank separator still costs a screen row; it is excluded from the hint's count
			// because the hint reports how many lines of reasoning went away, not spacing.
			contentRows: blank ? 0 : rows + quoteRow,
			sliceable: true,
			depth,
			fenced: false,
			marker: false,
		};
	});
}

/**
 * pi's own renderer, used to measure rows.
 *
 * Row accounting decides how much of a block the preview shows, so it has to agree with the
 * renderer that draws it: pi wraps with `wrapTextWithAnsi` (the same function this module cuts
 * lines with) and settles the rest with its own markdown parser — emphasis flanking rules,
 * indented code blocks, table cells, fence handling. Its markdown theme carries the block
 * prefixes (code block indent, list bullets, quote border) and closes over the live theme, so
 * a single instance follows a theme switch.
 *
 * The measurement is unstyled, on purpose. pi draws a thinking block through a colour callback,
 * and its own wrapping inserts an extra row when it breaks a token too long for the line under
 * that style (measured: one preview in ~5,300). Counting the unstyled render keeps a single code
 * path for every block instead of mirroring pi's styling, and the cost of that trade is bounded:
 * in the rare styled case the preview renders one row taller than the budget asked for.
 *
 * `measureLines` stays as the fallback: it needs no theme and reads the shapes this module
 * emits itself, so a renderer that cannot be built or used degrades instead of throwing inside
 * a streaming render.
 */
let renderer: Markdown | undefined;
let rendererUnavailable = false;

/** Rows `markdown` occupies when pi renders it at `width`; -1 when the renderer is unusable. */
function piRenderedRows(markdown: string, width: number): number {
	try {
		renderer ??= new Markdown("", 0, 0, getMarkdownTheme(), undefined, {});
		renderer.setText(markdown);
		return renderer.render(width).length;
	} catch {
		// A pi release whose renderer or theme is not what this expects must not break the
		// preview: the model below keeps the extension working, with coarser rows.
		rendererUnavailable = true;
		return -1;
	}
}

/** Which counter `countRenderedRows` measures with: pi's renderer, or this module's model. */
export function rowCounterSource(): "renderer" | "model" {
	return rendererUnavailable ? "model" : "renderer";
}

/** Rows a whole block occupies at `width`, i.e. the number of lines a reader counts. */
export function countRenderedRows(markdown: string, width: number): number {
	// Without a width there is nothing to render at, and the model's line-based answer is the
	// documented behaviour for that case.
	if (width > 0 && !rendererUnavailable) {
		const rows = piRenderedRows(markdown, width);
		if (rows >= 0) return rows;
	}
	const lines = markdown.replace(/\s+$/, "").split("\n");
	return measureLines(lines, width).reduce((rows, line) => rows + line.rows, 0);
}

interface ShownTail {
	/** Markdown for the tail that fits the budget. */
	shown: string;
	/** Rows (or, without a width, lines) left out above the tail. */
	hiddenRows: number;
}

interface TailSelection {
	/** Tail lines in source order; fence markers and blank separators are dropped. */
	lines: string[];
	/** Rendered rows of reasoning the selection keeps. */
	rows: number;
}

/** Bottom-up selection of the content lines that fit in `maxRows` rendered rows. */
function selectTail(
	lines: string[],
	measured: LineRow[],
	maxRows: number,
	width: number,
): TailSelection {
	if (maxRows <= 0) return { lines: [], rows: 0 };
	const tail: string[] = [];
	let rows = 0;
	let cutLine = -1;
	let cutRows = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		// Fence markers and blank separators never enter the tail: a marker on its own opens a
		// code block that swallows whatever follows it (and costs rows the reader did not ask
		// for), and a blank row would spend one of the reader's rows on spacing nobody sees.
		if (measured[i].marker || measured[i].contentRows === 0) continue;
		const rowsHere = measured[i].contentRows;
		if (rows + rowsHere > maxRows) {
			cutLine = i;
			cutRows = measured[i].sliceable ? maxRows - rows : 0;
			break;
		}
		rows += rowsHere;
		tail.unshift(lines[i]);
	}

	if (cutLine >= 0 && cutRows > 0) {
		const { body, columns } = splitLinePrefix(
			lines[cutLine],
			measured[cutLine].depth,
		);
		// Wrap the line the way pi renders it (inline markup consumed) and keep its last rows.
		// They are re-emitted as one source line per row: a long token pi broke across rows
		// cannot be re-wrapped into exactly the rows that were cut, but a line short enough to
		// fit costs exactly one row.
		const segments = wrapTextWithAnsi(
			markdownPlain(body),
			Math.max(1, width - columns),
		);
		const kept = segments.slice(Math.max(0, segments.length - cutRows));
		if (kept.length === cutRows) {
			for (let i = kept.length - 1; i >= 0; i--) tail.unshift(plainRow(kept[i]));
			rows += cutRows;
		}
	}
	return { lines: tail, rows };
}

/**
 * One rendered row re-emitted as a source line that cannot open a block of its own.
 *
 * A row that starts with a list bullet, a quote marker, a heading, a table pipe or a fence
 * would be rendered as its own block and take a different number of rows than the cut paid
 * for; escaping the first character keeps it plain text with the same visible columns.
 */
function plainRow(row: string): string {
	// A trailing space becomes a row of its own when the text ends exactly on the wrap column,
	// so the re-emitted rows carry no trailing whitespace.
	const text = row.replace(/^\s+/, "").replace(/\s+$/, "");
	return /^[-+*|>#`]|^\d{1,9}[.)]/.test(text) ? `\\${text}` : text;
}

/**
 * Take the tail of a block that fits in `maxRows` rendered rows.
 *
 * Rows are counted the way pi renders them: a long line the terminal wraps costs the
 * several rows it fills, and blank separators are dropped rather than counted, so every row
 * the tail occupies on screen is a row of reasoning. When the budget lands in the middle of
 * a line, the rows of that line the budget paid for are re-emitted as plain source lines (one
 * per row, marker dropped): a long token pi broke across rows cannot be re-wrapped into
 * exactly the rows that were cut, but a line short enough to fit costs exactly one row.
 *
 * `hiddenRows` reports the lines of reasoning left out above the tail (blank separators
 * are not counted as reasoning).
 */
export function tailByRows(
	markdown: string,
	maxRows: number,
	width: number,
): ShownTail {
	const trimmed = markdown.replace(/\s+$/, "");
	const lines = trimmed.split("\n");
	const measured = measureLines(lines, width);
	const renderedTotal = measured.reduce((rows, line) => rows + line.rows, 0);
	const contentTotal = measured.reduce(
		(rows, line) => rows + line.contentRows,
		0,
	);
	if (renderedTotal <= maxRows) return { shown: trimmed, hiddenRows: 0 };

	const selection = selectTail(lines, measured, maxRows, width);
	const hiddenRows = contentTotal - selection.rows;
	return {
		// pi renders a trailing space that lands on the wrap column as an extra empty row, which
		// the model does not count: the tail is emitted without trailing whitespace.
		shown: selection.lines
			.map((line) => line.replace(/[ \t]+$/, ""))
			.join("\n")
			.replace(/\s+$/, ""),
		hiddenRows,
	};
}

/**
 * The markdown the reader sees: the hint, a blank row, then the tail.
 *
 * The blank row is what keeps the budget exact. It ends the hint's paragraph, so pi never folds
 * the tail's first line into it: without the separator a tail line that starts with whitespace is
 * rendered as an indented continuation of the hint, which changes how it wraps and costs rows the
 * budget never asked for. Separated, the tail renders exactly as it does on its own, and the
 * composed preview is one row taller than the hint and the tail together whichever shape the tail
 * starts with (measured against pi for heading, quote, fence, table, list and prose tails).
 *
 * Fence markers are dropped with the tail, so the preview can never end on a dangling fence.
 */
function preview(hint: string, body: string): string {
	if (hint === "") return body;
	if (body === "") return hint;
	return `${hint}\n\n${body}`;
}

/** The hint above a tail, reporting how many lines of reasoning it left out. */
function previewHint(hiddenRows: number): string {
	const unit = hiddenRows === 1 ? "line" : "lines";
	return `... (${hiddenRows} earlier ${unit}, ${expandHint()})`;
}

/**
 * Render a thinking block for display: the last rows of the block with a hint above
 * reporting how many earlier lines were dropped.
 *
 * `maxLines` is how many rows of reasoning the reader gets: `maxLines = 5` shows five rows
 * of reasoning, with the hint reporting the dropped lines and the blank row under it sitting
 * above them without being charged to the budget. Rows are measured as pi renders them when
 * `width` is a positive number (the wrap width pi passes as `availableWidth`, so a long line
 * counts as the several rows it fills) and as source lines otherwise. The block therefore
 * keeps the same height while it streams. A block no taller than `maxLines` is returned
 * untouched, hint and all.
 * `maxLines = 0` disables the preview entirely (markdown is returned untouched).
 */
export function truncateThinking(
	markdown: string,
	maxLines: number,
	options: { width?: number } = {},
): string {
	if (maxLines <= 0) return markdown;

	const width =
		options.width !== undefined && options.width > 0 ? options.width : 0;
	// A block that already fits the whole budget is shown as it is, hint and all.
	if (countRenderedRows(markdown, width) <= maxLines)
		return markdown.replace(/\s+$/, "");

	const bordered = compose(markdown, maxLines, width);
	if (bordered.exact) return bordered.shown;
	// pi renders a blockquote as its own block with an empty row in front of it, which a tight
	// budget cannot pay for. Retry without the quote markers: the text stays, the row goes.
	const plain = compose(dropQuoteBorders(markdown), maxLines, width);
	return countRenderedRows(plain.shown, width) >
		countRenderedRows(bordered.shown, width)
		? plain.shown
		: bordered.shown;
}

/** The quote borders a block would show, removed so the text renders as plain rows. */
function dropQuoteBorders(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => line.replace(QUOTE_PREFIX, ""))
		.join("\n");
}

/**
 * The preview for `maxLines` reasoning rows, or the tallest one under it when the block
 * cannot fill the budget exactly (a hint plus a blockquote need more rows than a one-row
 * preview has).
 */
/**
 * How far below the budget the composition scans for a tail that fits.
 *
 * The composition picks a tail with the line model and then measures it with pi's renderer, and
 * pi inserts rows of its own (around headings, when it breaks a long token across two), so the
 * modelled count and the rendered one differ by a row or two. The exact fit is searched from the
 * budget downwards, and the scan is bounded because every step costs a render.
 */
const BUDGET_SCAN = 6;

function compose(
	markdown: string,
	maxLines: number,
	width: number,
): { shown: string; exact: boolean } {
	// The hint is not charged to the budget: maxLines buys reasoning rows, and the hint's own
	// rows (it wraps when the preview is narrow) sit above them.
	//
	// The tail is measured with pi's renderer rather than trusted from the model: pi inserts rows
	// the model cannot see (around headings, when it breaks a long token), so the budget is
	// scanned downwards for the tallest tail that still renders inside maxLines. Measuring the
	// composed preview instead lets the renderer's answer feed back into the budget, which
	// oscillates between two tails — the reader asks for five rows, the model pays for six, the
	// renderer draws eight, the budget drops to three.
	let best = "";
	let bestRows = 0;
	let tallest = "";
	let tallestBody = "";
	let tallestHint = "";
	for (
		let budget = maxLines;
		budget >= 0 && budget >= maxLines - BUDGET_SCAN;
		budget--
	) {
		const { shown: body, hiddenRows } = tailByRows(
			markdown,
			Math.max(0, budget),
			width,
		);
		const hint = hiddenRows > 0 ? previewHint(hiddenRows) : "";
		const candidate = preview(hint, body);
		if (tallestBody === "" && candidate !== "") {
			tallest = candidate;
			tallestBody = body;
			tallestHint = hint;
		}
		if (body === "") continue;
		// The tail is measured on its own: the separator in `preview` keeps the hint from changing
		// how it renders, so the body's rows are the reasoning rows the reader counts.
		const rows = countRenderedRows(body, width);
		if (rows > maxLines) continue;
		if (rows === maxLines) return { shown: candidate, exact: true };
		// A budget below the one that fit can render taller (a heading dropped from the top of the
		// tail joins the hint's paragraph), so the tallest fit seen is kept rather than the first.
		if (rows > bestRows) {
			best = candidate;
			bestRows = rows;
		}
	}
	if (best !== "") return { shown: best, exact: false };
	let shown = tallest;
	let body = tallestBody;
	const hint = tallestHint;
	// Whatever the composition did, never hand pi more reasoning rows than the budget: only the
	// hint and its separator row may sit above them.
	for (let pass = 0; pass < 4; pass++) {
		if (body === "" || countRenderedRows(body, width) <= maxLines) break;
		const lines = body.split("\n");
		body = lines.length > 1 ? lines.slice(1).join("\n") : "";
	}
	shown = body === "" ? "" : preview(hint, body);
	return { shown, exact: false };
}

/** Everything the event handlers need to talk to the UI. */
interface UiContext {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setHiddenThinkingLabel: (label?: string) => void;
		onTerminalInput: (
			handler: (data: string) => { consume?: boolean; data?: string } | undefined,
		) => () => void;
	};
}

export default function (pi: ExtensionAPI) {
	let state = resolveInitialState();

	pi.registerFlag("thinking-preview", {
		description:
			"Thinking level for this run: full | preview | hidden | <lines> (default: preview, N rows of reasoning with the hint above them)",
		type: "string",
	});

	const flagValue = pi.getFlag("thinking-preview");
	if (typeof flagValue === "string" && flagValue.trim() !== "") {
		const spec = parseViewSpec(flagValue);
		if (spec !== null)
			state = { view: spec.view, lines: spec.lines || DEFAULT_STATE.lines };
	}

	pi.registerMarkdownTransformer(createThinkingTransformer(() => state));

	// Set from session_start; the Ctrl+T handler and command need it too.
	let ui: UiContext["ui"] | null = null;
	let stopInput: (() => void) | null = null;

	const applyState = (next: ThinkingState, announce?: string): void => {
		state = next;
		saveState(state);
		if (ui === null) return;
		refreshTranscript(ui);
		if (announce !== undefined) ui.notify(announce);
		if (state.view !== "hidden" && hideThinkingBlockEnabled())
			ui.notify(hiddenWarning(), "warning");
	};

	pi.registerCommand("thinking-preview", {
		description:
			"Thinking display level: full (whole block) | preview (last N rows of reasoning) | hidden. Usage: /thinking-preview [n|full|preview|hidden]",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const raw = args.trim().toLowerCase();

			if (!raw) {
				const rowsFrom =
					rowCounterSource() === "renderer"
						? "pi 렌더러"
						: "자체 행 모델(폴백)";
				ctx.ui.notify(
					`추론 표시 단계: ${state.view}${state.view === "preview" ? ` (추론 ${state.lines}줄 + 힌트)` : ""} — 행 계산: ${rowsFrom} — Ctrl+T로 단계 순환 (full → preview → hidden). 변경: /thinking-preview full|preview|hidden|<줄수>`,
				);
				if (state.view !== "hidden" && hideThinkingBlockEnabled())
					ctx.ui.notify(hiddenWarning(), "warning");
				return;
			}

			const spec = parseViewSpec(raw);
			if (spec === null) {
				ctx.ui.notify(
					`잘못된 값 '${raw}'. full | preview | hidden 또는 1-${MAX_PREVIEW_LINES} 사이 숫자를 쓰세요.`,
					"warning",
				);
				return;
			}

			// A bare level name keeps the current tail size; a number sets it.
			const next: ThinkingState = /^\d+$/.test(raw)
				? spec
				: {
						view: spec.view,
						lines: state.lines || DEFAULT_STATE.lines,
					};
			applyState(
				next,
				`추론 표시 단계: ${next.view}${next.view === "preview" ? ` (추론 ${next.lines}줄 + 힌트)` : ""} — 지나간 블록까지 즉시 다시 그렸습니다.`,
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		if (state.view !== "hidden" && hideThinkingBlockEnabled())
			ctx.ui.notify(hiddenWarning(), "warning");

		// Ctrl+T is reserved for pi's built-in thinking toggle, so it cannot be claimed
		// with registerShortcut. Intercept the raw keypress instead and consume it: the
		// built-in handler never runs, so pi's hideThinkingBlock setting stays false and
		// this extension owns the three display levels.
		stopInput?.();
		stopInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, TOGGLE_KEY)) return undefined;
			const next = { ...state, view: nextView(state.view) };
			state = next;
			saveState(state);
			refreshTranscript(ctx.ui);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		stopInput?.();
		stopInput = null;
		ui = null;
	});
}
