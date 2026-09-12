/**
 * Thinking Preview Extension
 *
 * Gives thinking blocks three display levels instead of pi's built-in two, and
 * cycles them with Ctrl+T:
 *
 *   1. full     every line of the block (plus the `Took <duration>` footer)
 *   2. preview  the *tail* of the block: the last N lines with a
 *               `... (X earlier lines, ctrl+t)` hint above (default level)
 *   3. hidden   a single muted `Thinking...` line, nothing else
 *
 * Defaults:
 *   level = preview, N = 3 lines
 *   Override at load time with PI_THINKING_PREVIEW_VIEW=<full|preview|hidden>
 *   and/or PI_THINKING_PREVIEW_LINES=<n>, or per run with --thinking-preview=<value>.
 *   Hint text: PI_THINKING_PREVIEW_HINT="<text>", hidden label: PI_THINKING_HIDDEN_LABEL.
 *
 * Commands:
 *   /thinking-preview            show the current level
 *   /thinking-preview <n>        preview the last <n> lines (1-500)
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
 *   - The `Took`/`Elapsed` footer is measured from this extension's first render
 *     of a block to its first non-streaming render, so it approximates the time
 *     that block spent thinking. Blocks restored from an older session were never
 *     observed live and therefore show no footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
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

/** How many finished blocks keep their measured duration (FIFO eviction). */
const TIMED_BLOCK_LIMIT = 64;

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

/** Same format pi uses for its tool-duration footer (e.g. "3.6s"). */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
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

/** `Took <d>` for a finished block, `Elapsed <d>` while it still streams. */
export function thinkingFooter(
	options: { durationMs?: number | null; isStreaming?: boolean } = {},
): string | null {
	if (options.durationMs === undefined || options.durationMs === null)
		return null;
	return `${options.isStreaming ? "Elapsed" : "Took"} ${formatDuration(options.durationMs)}`;
}

interface BlockTiming {
	/** Latest markdown seen for the block that is currently streaming. */
	key: string;
	startedAt: number;
	sawStreaming: boolean;
	durationMs: number | null;
}

/**
 * Track how long each thinking block spends streaming.
 *
 * Markdown transformers only receive the block's current text plus an
 * `isStreaming` flag, so a duration is measured from the first streaming render
 * of a block to its first non-streaming render. Finished durations are memoised
 * by a signature of the block text, so transcript re-renders (resize, /reload,
 * Ctrl+T, redraws) keep reporting the original time instead of restarting it.
 *
 * Returns an `observe(markdown, isStreaming, now?)` function that yields the
 * block's duration in ms, or null while it is unknown.
 */
export function createThinkingTiming() {
	let active: BlockTiming | null = null;
	const timed = new Map<string, number>();
	const signature = (markdown: string) => markdown.trim().slice(0, 120);

	return function observe(
		markdown: string,
		isStreaming: boolean,
		now = Date.now(),
	): number | null {
		const signatureKey = signature(markdown);

		if (active !== null && markdown.startsWith(active.key)) {
			active.key = markdown;
			active.sawStreaming ||= isStreaming;
			if (!isStreaming && active.sawStreaming && active.durationMs === null) {
				active.durationMs = now - active.startedAt;
				timed.set(signatureKey, active.durationMs);
				if (timed.size > TIMED_BLOCK_LIMIT) {
					const oldest = timed.keys().next().value;
					if (oldest !== undefined) timed.delete(oldest);
				}
			}
			return active.durationMs;
		}

		const known = timed.get(signatureKey);
		if (known !== undefined) return known;
		// A finished block we never watched stream (restored session, scroll-back): it has
		// no measurable duration, and it must not clobber a block that is streaming now.
		if (!isStreaming) return null;

		active = {
			key: markdown,
			startedAt: now,
			sawStreaming: true,
			durationMs: null,
		};
		return null;
	};
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
 * answer text included — so the thinking gate below is what keeps previews and
 * duration footers out of the response body. It is also what makes this factory
 * (rather than a raw arrow function) the thing tests exercise.
 *
 * `observe` is injectable so tests can supply deterministic durations.
 */
export function createThinkingTransformer(
	getState: () => ThinkingState,
	observe: (
		markdown: string,
		isStreaming: boolean,
	) => number | null = createThinkingTiming(),
): (
	markdown: string,
	context: { messageType?: string; kind?: string; isStreaming: boolean },
) => string {
	return (markdown, context) => {
		if (!isThinkingContext(context)) return markdown;
		const state = getState();
		const durationMs = observe(markdown, context.isStreaming);

		if (state.view === "hidden") return hiddenLabel();

		if (state.view === "full") {
			const footer = thinkingFooter({
				durationMs,
				isStreaming: context.isStreaming,
			});
			return footer === null
				? markdown
				: `${markdown.replace(/\s+$/, "")}\n\n${footer}`;
		}

		return truncateThinking(markdown, state.lines, {
			durationMs,
			isStreaming: context.isStreaming,
		});
	};
}

/**
 * Render a thinking block for display: the last `maxLines` non-blank lines, a hint
 * above reporting how many earlier lines were dropped, and (when known) a
 * `Took`/`Elapsed` footer. Blank lines used as paragraph separators travel with the
 * lines around them, so the budget matches what a reader counts on screen.
 * `maxLines = 0` disables the preview entirely (markdown is returned untouched).
 */
export function truncateThinking(
	markdown: string,
	maxLines: number,
	options: { durationMs?: number | null; isStreaming?: boolean } = {},
): string {
	if (maxLines <= 0) return markdown;

	const lines = markdown.replace(/\s+$/, "").split("\n");
	const totalLines = lines.filter((line) => line.trim() !== "").length;

	let cutIndex = 0;
	if (totalLines > maxLines) {
		let seen = 0;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].trim() === "") continue;
			seen++;
			if (seen === maxLines) {
				cutIndex = i;
				break;
			}
		}
	}

	const tail = lines.slice(cutIndex);
	// Drop separators that used to sit above the tail: the hint takes their place.
	while (tail.length > 0 && tail[0].trim() === "") tail.shift();

	const earlier = totalLines - tail.filter((line) => line.trim() !== "").length;
	let shown = tail.join("\n").replace(/\s+$/, "");

	// A dangling code fence would swallow the footer (and look broken), so close it.
	const fenceCount = (shown.match(/^\s*```/gm) ?? []).length;
	if (fenceCount % 2 === 1) shown += "\n```";

	const parts: string[] = [];
	if (earlier > 0)
		parts.push(
			`... (${earlier} earlier ${earlier === 1 ? "line" : "lines"}, ${expandHint()})`,
		);
	if (shown !== "") parts.push(shown);
	const footer = thinkingFooter(options);
	if (footer !== null) parts.push(footer);

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
			"Thinking display level: full (whole block) | preview (last N lines + 'Took Xs') | hidden. Usage: /thinking-preview [n|full|preview|hidden]",
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
