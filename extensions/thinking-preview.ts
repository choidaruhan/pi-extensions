/**
 * Thinking Preview Extension
 *
 * Gives thinking blocks three display levels instead of pi's built-in two, and
 * cycles them with Ctrl+T:
 *
 *   1. full     every line of the block
 *   2. preview  the *tail* of the block: the last N rendered rows of reasoning with a
 *               `... (X earlier lines, ctrl+t)` hint above (default level). N counts rows
 *               as they land on screen, so a line the terminal wraps costs the several rows
 *               it fills and a budget that ends mid-line shows the tail of that line; blank
 *               separators between parts are free.
 *   3. hidden   a single muted `Thinking...` line, nothing else
 *
 * Defaults:
 *   level = preview, N = 3 rows
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PREVIEW_LINES = 3;
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

/** Which level the transcript is showing, for the status line. */
function statusText(state: ThinkingState): string {
	if (state.view === "full") return "thinking:full";
	if (state.view === "hidden") return "thinking:hidden";
	return `thinking:preview(${state.lines})`;
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
export function createThinkingTransformer(
	getState: () => ThinkingState,
): (
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

/**
 * Measure how many rows each source line occupies at `width`.
 *
 * `width <= 0` means "no wrapping information": every non-blank line counts as one row,
 * which is the line-based behaviour of earlier versions. List nesting is resolved the way
 * markdown does it — relative to the enclosing item's content column — so `  - a` inside a
 * top-level item is one level deep, exactly as pi renders it.
 */
export function measureLines(lines: string[], width: number): LineRow[] {
	const levels: { depth: number; content: number }[] = [];
	let inFence = false;

	return lines.map((line) => {
		const blank = line.trim() === "";
		if (!(width > 0))
			return {
				rows: blank ? 0 : 1,
				contentRows: blank ? 0 : 1,
				sliceable: false,
				depth: 0,
				fenced: false,
				marker: false,
			};

		if (FENCE.test(line)) {
			levels.length = 0;
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
		let depth = 0;
		if (list !== null) {
			const indent = list[1].length;
			while (levels.length > 0 && levels[levels.length - 1].content > indent)
				levels.pop();
			depth = levels.length === 0 ? 0 : levels[levels.length - 1].depth + 1;
			levels.push({ depth, content: indent + list[0].length });
		} else if (line.trim() !== "") {
			levels.length = 0;
		}

		const { body, columns } = splitLinePrefix(line, depth);
		const rows = blank
			? 1
			: wrapTextWithAnsi(body, Math.max(1, width - columns)).length;
		return {
			rows,
			// Blank separators are structural: they are free in the preview budget, so a
			// budget of N shows N lines of reasoning rather than N screen rows of spacing.
			contentRows: blank ? 0 : rows,
			sliceable: true,
			depth,
			fenced: false,
			marker: false,
		};
	});
}

/** Rows a whole block occupies at `width`, i.e. the number of lines a reader counts. */
export function countRenderedRows(markdown: string, width: number): number {
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
	lines: string[];
	/** Rows of the original block the selection keeps (blank separators not counted). */
	rows: number;
}

/** Bottom-up selection of the lines that fit in `maxRows`. */
function selectTail(
	lines: string[],
	measured: LineRow[],
	maxRows: number,
	width: number,
): TailSelection {
	if (maxRows <= 0) return { lines: [], rows: 0 };

	let rows = 0;
	let start = lines.length;
	let cutLine = -1;
	let cutRows = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		// Fence markers are never part of the shown tail. On its own a marker renders as a
		// code block that swallows whatever follows it and costs rows the reader did not ask
		// for, so dropping it keeps the shown text plain and the row count exact.
		if (measured[i].marker) continue;
		const rowsHere = measured[i].contentRows;
		if (rows + rowsHere > maxRows) {
			cutLine = i;
			cutRows = measured[i].sliceable ? maxRows - rows : 0;
			break;
		}
		rows += rowsHere;
		start = i;
	}

	const kept: string[] = [];
	if (cutLine >= 0 && cutRows > 0) {
		const { prefix, body, columns } = splitLinePrefix(
			lines[cutLine],
			measured[cutLine].depth,
		);
		const segments = wrapTextWithAnsi(body, Math.max(1, width - columns));
		// Walk the dropped segments through the source so the cut lands exactly where the
		// wrapped rows split: each row break swallows a space, so column arithmetic alone
		// would leave the kept text too long.
		let offset = 0;
		for (let i = 0; i < segments.length - cutRows; i++) {
			const at = body.indexOf(segments[i], offset);
			if (at < 0) break;
			offset = at + segments[i].length;
		}
		// Re-emit the marker, but without its indentation: a nested item rendered on its own
		// would be parsed as a code block instead of a list item.
		kept.push(
			`${prefix.replace(/^\s+/, "")}${body.slice(offset).replace(/^\s+/, "")}`,
		);
		rows += cutRows;
	}
	kept.push(...lines.slice(start));
	return { lines: kept, rows };
}

/**
 * Take the tail of a block that fits in `maxRows` rendered rows.
 *
 * Rows are counted the way pi renders them, so a single long line that the terminal
 * wraps is counted as the several rows it occupies rather than one. When the budget
 * lands in the middle of a line, the front of that line is dropped and the line's own
 * prefix (blockquote border, list marker) is re-emitted, so the visible fragment keeps
 * wrapping at the same width pi would have used.
 */
export function tailByRows(
	markdown: string,
	maxRows: number,
	width: number,
): ShownTail {
	const trimmed = markdown.replace(/\s+$/, "");
	const lines = trimmed.split("\n");
	const measured = measureLines(lines, width);
	// "Everything fits" is a question about screen rows (blank separators included); the
	// budget the tail is cut to counts content rows only.
	const renderedTotal = measured.reduce((rows, line) => rows + line.rows, 0);
	const contentTotal = measured.reduce(
		(rows, line) => rows + line.contentRows,
		0,
	);
	if (renderedTotal <= maxRows) return { shown: trimmed, hiddenRows: 0 };

	const selection = selectTail(lines, measured, maxRows, width);
	const tail = selection.lines;
	// Blank separators that used to sit above the tail are dropped: the hint takes their place.
	let hiddenRows = contentTotal - selection.rows;
	while (tail.length > 0 && tail[0].trim() === "") {
		hiddenRows += measureLines([tail[0]], width)[0].contentRows;
		tail.shift();
	}
	return {
		shown: tail.join("\n").replace(/\s+$/, ""),
		hiddenRows,
	};
}

/**
 * Render a thinking block for display: the last `maxLines` rows with a hint above
 * reporting how many earlier rows were dropped.
 *
 * `maxLines` counts rendered rows when `width` is a positive number — the wrap width pi
 * passes as `availableWidth`, so a long line counts as the several rows it fills — and
 * non-blank source lines otherwise. `maxLines = 0` disables the preview entirely
 * (markdown is returned untouched).
 */
export function truncateThinking(
	markdown: string,
	maxLines: number,
	options: { width?: number } = {},
): string {
	if (maxLines <= 0) return markdown;

	const width =
		options.width !== undefined && options.width > 0 ? options.width : 0;
	const { shown: body, hiddenRows } = tailByRows(markdown, maxLines, width);

	let shown = body;

	// A dangling code fence would swallow everything after it (and look broken), so close it.
	const fenceCount = (shown.match(/^\s*```/gm) ?? []).length;
	if (fenceCount % 2 === 1) shown += "\n```";

	const parts: string[] = [];
	if (hiddenRows > 0) {
		const unit = hiddenRows === 1 ? "line" : "lines";
		parts.push(`... (${hiddenRows} earlier ${unit}, ${expandHint()})`);
	}
	if (shown !== "") parts.push(shown);

	return parts.join("\n\n");
}

/** Everything the event handlers need to talk to the UI. */
interface UiContext {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus: (key: string, text: string | undefined) => void;
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
			"Thinking level for this run: full | preview | hidden | <lines> (default: preview 3)",
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
			"Thinking display level: full (whole block) | preview (last N lines) | hidden. Usage: /thinking-preview [n|full|preview|hidden]",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const raw = args.trim().toLowerCase();

			if (!raw) {
				ctx.ui.notify(
					`추론 표시 단계: ${state.view}${state.view === "preview" ? ` (마지막 ${state.lines}줄)` : ""} — Ctrl+T로 단계 순환 (full → preview → hidden). 변경: /thinking-preview full|preview|hidden|<줄수>`,
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
				`추론 표시 단계: ${next.view}${next.view === "preview" ? ` (마지막 ${next.lines}줄)` : ""} — 지나간 블록까지 즉시 다시 그렸습니다.`,
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		ctx.ui.setStatus("thinking-preview", statusText(state));
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
			ctx.ui.setStatus("thinking-preview", statusText(state));
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		stopInput?.();
		stopInput = null;
		ui = null;
	});
}
