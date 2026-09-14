/**
 * Thinking Preview Extension (simple)
 *
 * Three display levels for thinking blocks, cycled with Ctrl+T:
 *
 *   full     the whole block
 *   preview  the last N lines of reasoning under a "... (X earlier lines)" hint (default)
 *   hidden   one muted "Thinking..." line
 *
 * The budget is N lines of *reasoning*, counted on the source lines. Blank separators are
 * neither spent from the budget nor reported by the hint, so the hint always says exactly how
 * many lines went away. The budget is lines, not screen rows: a line the terminal wraps makes
 * the block taller than N rows. That is the trade for a transformer that is pure string work
 * on every streaming update — no markdown parsing, no width measurement, no row model.
 *
 * Levels persist in ~/.pi/agent/thinking-preview.json; overrides are
 * `--thinking-preview=<full|preview|hidden|n>`, PI_THINKING_PREVIEW_VIEW,
 * PI_THINKING_PREVIEW_LINES, PI_THINKING_PREVIEW_HINT and PI_THINKING_HIDDEN_LABEL.
 * Command: `/thinking-preview [n|full|preview|hidden]`.
 *
 * Ctrl+T is pi's own "app.thinking.toggle", so it cannot be claimed with registerShortcut; the
 * extension intercepts the raw keypress with ctx.ui.onTerminalInput() and consumes it, which
 * also keeps pi from flipping the hideThinkingBlock setting behind our back (pi reads that
 * setting once at session start, and when it is true the renderer never runs transformers).
 *
 * Display only: the model context is never touched, and the only write is this extension's
 * own state file.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ThinkingView = "full" | "preview" | "hidden";

/** Cycle order for Ctrl+T. */
export const THINKING_VIEWS: readonly ThinkingView[] = [
	"full",
	"preview",
	"hidden",
];

export const DEFAULT_LINES = 5;
export const MAX_LINES = 500;

export interface ThinkingState {
	view: ThinkingView;
	/** Tail size of the "preview" level, in lines of reasoning. */
	lines: number;
}

export const DEFAULT_STATE: ThinkingState = {
	view: "preview",
	lines: DEFAULT_LINES,
};

/** Key that cycles levels (pi's own "app.thinking.toggle" binding). */
const TOGGLE_KEY = "ctrl+t";
const DEFAULT_HIDDEN_LABEL = "Thinking...";
const DEFAULT_HINT_SUFFIX = "ctrl+t to cycle";

const AGENT_DIR = (
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent")
).replace(/\/+$/, "");
const STATE_PATH = join(AGENT_DIR, "thinking-preview.json");

export function clampLines(value: number): number {
	const n = Math.trunc(value);
	if (!Number.isFinite(n)) return DEFAULT_LINES;
	return Math.max(1, Math.min(n, MAX_LINES));
}

function isView(value: unknown): value is ThinkingView {
	return THINKING_VIEWS.includes(value as ThinkingView);
}

/**
 * Parse a level spec shared by the flag, the env vars and the command: a view name, or a line
 * count (0 is the hidden level, n >= 1 previews n lines).
 */
export function parseViewSpec(raw: string): ThinkingState | null {
	const value = raw.trim().toLowerCase();
	if (value === "") return null;
	if (isView(value)) return { view: value, lines: DEFAULT_LINES };
	if (value === "all" || value === "off" || value === "show")
		return { view: "full", lines: DEFAULT_LINES };
	if (value === "on") return { view: "preview", lines: DEFAULT_LINES };
	if (value === "hide" || value === "none")
		return { view: "hidden", lines: DEFAULT_LINES };
	const number = Number.parseInt(value, 10);
	if (!Number.isFinite(number) || number < 0) return null;
	return number === 0
		? { view: "hidden", lines: DEFAULT_LINES }
		: { view: "preview", lines: clampLines(number) };
}

/** The level Ctrl+T moves to next. */
export function nextView(view: ThinkingView): ThinkingView {
	return THINKING_VIEWS[(THINKING_VIEWS.indexOf(view) + 1) % THINKING_VIEWS.length];
}

/** The saved level, or null when there is none (or the file is unreadable). */
export function loadSavedState(path = STATE_PATH): ThinkingState | null {
	try {
		const saved = JSON.parse(readFileSync(path, "utf8")) as {
			view?: unknown;
			lines?: unknown;
			/** Written by the pre-level version of this extension. */
			previewLines?: unknown;
		};
		const raw = saved.lines ?? saved.previewLines;
		const lines =
			typeof raw === "number" && Number.isFinite(raw)
				? clampLines(raw)
				: DEFAULT_LINES;
		return isView(saved.view) ? { view: saved.view, lines } : null;
	} catch {
		return null;
	}
}

export function saveState(state: ThinkingState, path = STATE_PATH): void {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	} catch {
		// Best effort: a read-only home must not break the command.
	}
}

/** Saved state, then the env override, then the built-in default. */
export function resolveInitialState(
	env: Record<string, string | undefined> = process.env,
): ThinkingState {
	const saved = loadSavedState() ?? DEFAULT_STATE;
	const spec = env.PI_THINKING_PREVIEW_VIEW;
	if (spec !== undefined && spec.trim() !== "") {
		const parsed = parseViewSpec(spec);
		// A bare view name keeps whatever tail size the user already had.
		if (parsed !== null) return { ...parsed, lines: saved.lines };
	}
	const decimals = env.PI_THINKING_PREVIEW_LINES;
	if (decimals !== undefined && decimals.trim() !== "") {
		const parsed = parseViewSpec(decimals);
		if (parsed !== null) return parsed;
	}
	return saved;
}

/**
 * Read pi's own hideThinkingBlock setting (project layer over global). The extension API has
 * no getter, and when the setting is true pi renders the hidden label through a path that
 * never consults markdown transformers, so the preview would silently do nothing.
 */
export function hideThinkingBlockEnabled(cwd = process.cwd()): boolean {
	for (const path of [
		join(cwd, ".pi", "settings.json"),
		join(AGENT_DIR, "settings.json"),
	]) {
		try {
			const settings = JSON.parse(readFileSync(path, "utf8")) as {
				hideThinkingBlock?: unknown;
			};
			if (typeof settings.hideThinkingBlock === "boolean")
				return settings.hideThinkingBlock;
		} catch {
			// Missing or malformed layer: fall through to the next one.
		}
	}
	return false;
}

function hiddenWarning(): string {
	return `thinking-preview: hideThinkingBlock=true 라 pi가 추론 블록을 통째로 접어 이 확장이 그릴 수 없습니다. ${join(AGENT_DIR, "settings.json")} 에서 false로 바꾸고 /reload 하세요.`;
}

/** Hint text; override without editing code via PI_THINKING_PREVIEW_HINT. */
export function hintSuffix(): string {
	const raw = process.env.PI_THINKING_PREVIEW_HINT;
	return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_HINT_SUFFIX;
}

/** Label used by the "hidden" level; override via PI_THINKING_HIDDEN_LABEL. */
export function hiddenLabel(): string {
	const raw = process.env.PI_THINKING_HIDDEN_LABEL;
	return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_HIDDEN_LABEL;
}

/**
 * The last `maxLines` lines of reasoning under a hint naming how many it left out.
 *
 * Blank separators are not reasoning: they are never spent from the budget and never reported
 * as hidden. They do stay in the tail when they fall inside it, so paragraphs and fenced
 * blocks keep their shape. A block no taller than the budget is returned untouched.
 */
export function truncateThinking(markdown: string, maxLines: number): string {
	const text = markdown.replace(/\s+$/, "");
	if (maxLines <= 0 || text === "") return text;
	const lines = text.split("\n");
	const total = lines.filter((line) => line.trim() !== "").length;
	if (total <= maxLines) return text;

	// Walk back from the end until the tail holds `maxLines` lines of reasoning; `start` stays
	// on the line that was one too many, so the blank separators in front are dropped.
	let kept = 0;
	let start = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== "") kept++;
		if (kept > maxLines) break;
		start = i;
	}
	const tail = lines.slice(start).join("\n").replace(/^\n+/, "");
	const hidden = total - maxLines;
	return `${hint(hidden)}\n${tail}`;
}

function hint(hidden: number): string {
	const suffix = hintSuffix();
	const lines = `${hidden} earlier line${hidden === 1 ? "" : "s"}`;
	return `... (${lines}${suffix === "" ? "" : `, ${suffix}`})`;
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
 * The markdown transformer the extension registers.
 *
 * pi runs every transformer over every assistant markdown part — the answer text included —
 * so the thinking gate is what keeps previews out of the response body.
 */
export function createThinkingTransformer(
	getState: () => ThinkingState,
): (
	markdown: string,
	context: { messageType?: string; kind?: string; isStreaming?: boolean },
) => string {
	return (markdown, context) => {
		if (!isThinkingContext(context)) return markdown;
		const state = getState();
		if (state.view === "hidden") return hiddenLabel();
		if (state.view === "full") return markdown;
		return truncateThinking(markdown, state.lines);
	};
}

/** Force already-rendered assistant messages to re-render through the transformer. */
function refreshTranscript(ui: { setHiddenThinkingLabel: (label?: string) => void }): void {
	// The UI API has no redraw entry point; the no-argument form of setHiddenThinkingLabel is
	// the call pi itself makes after a settings reload, and it updates every transcript
	// component. See docs/extensions.md (ExtensionUIContext members).
	ui.setHiddenThinkingLabel();
}

export default function (pi: ExtensionAPI) {
	let state = resolveInitialState();

	pi.registerFlag("thinking-preview", {
		description:
			"Thinking level for this run: full | preview | hidden | <lines> (default: preview)",
		type: "string",
	});
	const flag = pi.getFlag("thinking-preview");
	if (typeof flag === "string" && flag.trim() !== "") {
		const parsed = parseViewSpec(flag);
		if (parsed !== null) state = parsed;
	}

	pi.registerMarkdownTransformer(createThinkingTransformer(() => state));

	let stopInput: (() => void) | null = null;

	const apply = (next: ThinkingState, ctx: ExtensionContext, announce?: string): void => {
		state = next;
		saveState(state);
		refreshTranscript(ctx.ui);
		if (announce !== undefined) ctx.ui.notify(announce);
		if (state.view !== "hidden" && hideThinkingBlockEnabled())
			ctx.ui.notify(hiddenWarning(), "warning");
	};

	const describe = (): string =>
		state.view === "preview"
			? `preview (추론 ${state.lines}줄 + 힌트)`
			: state.view;

	pi.registerCommand("thinking-preview", {
		description:
			"Thinking display level: full (whole block) | preview (last N lines) | hidden. Usage: /thinking-preview [n|full|preview|hidden]",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			if (raw === "") {
				ctx.ui.notify(
					`추론 표시 단계: ${describe()} — Ctrl+T로 단계 순환 (full → preview → hidden). 변경: /thinking-preview full|preview|hidden|<줄수>`,
				);
				if (state.view !== "hidden" && hideThinkingBlockEnabled())
					ctx.ui.notify(hiddenWarning(), "warning");
				return;
			}

			const parsed = parseViewSpec(raw);
			if (parsed === null) {
				ctx.ui.notify(
					`잘못된 값 '${raw}'. full | preview | hidden 또는 1-${MAX_LINES} 사이 숫자를 쓰세요.`,
					"warning",
				);
				return;
			}
			// A bare level name keeps the current tail size; a number sets it.
			apply(
				/^\d+$/.test(raw) ? parsed : { view: parsed.view, lines: state.lines },
				ctx,
				`추론 표시 단계: ${describe()} — 지나간 블록까지 다시 그렸습니다.`,
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (state.view !== "hidden" && hideThinkingBlockEnabled())
			ctx.ui.notify(hiddenWarning(), "warning");

		// Ctrl+T is reserved for pi's built-in toggle, so intercept the raw keypress and
		// consume it: the built-in handler never runs, pi's hideThinkingBlock setting stays
		// untouched, and this extension owns the three levels. Re-registering per session
		// needs the old subscription dropped first, or one keypress would advance twice.
		stopInput?.();
		stopInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, TOGGLE_KEY)) return undefined;
			apply({ view: nextView(state.view), lines: state.lines }, ctx);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		stopInput?.();
		stopInput = null;
	});
}
