/**
 * Thinking Preview Extension
 *
 * Instead of hiding reasoning blocks completely (`hideThinkingBlock: true`) or
 * dumping every line of them, show the *tail* of each thinking block: the last N
 * lines (the most recent reasoning), with a `... (X earlier lines, ctrl+o to
 * expand)` hint above and a `Took <duration>` footer below — the same shape pi
 * itself uses for collapsed tool output.
 *
 * Defaults:
 *   N = 3 lines, override at load time with PI_THINKING_PREVIEW_LINES=<n>
 *   or per run with --thinking-preview <n>
 *   Hint text: PI_THINKING_PREVIEW_HINT="<text>"
 *
 * Commands:
 *   /thinking-preview            show current setting
 *   /thinking-preview <n>        preview the last <n> lines (1-500)
 *   /thinking-preview off        disable truncation (render full thinking)
 *
 * Notes:
 *   - Applies to rendered output only; model context is untouched.
 *   - Ctrl+T still hides thinking blocks entirely (built-in setting
 *     hideThinkingBlock), so this extension is about the *visible* state.
 *   - When hideThinkingBlock is true the renderer takes a Text() path that never
 *     consults markdown transformers, so this preview cannot run; the extension
 *     warns at session start in that case.
 *   - The `Took`/`Elapsed` footer is measured from this extension's first render
 *     of a block to its first non-streaming render, so it approximates the time
 *     that block spent thinking. Blocks restored from an older session were never
 *     observed live and therefore show no footer.
 *   - `ctrl+o` in the hint mirrors pi's tool-output hint (app.tools.expand).
 *     Expanding the thinking itself is `/thinking-preview off`; Ctrl+T toggles
 *     thinking blocks entirely (built-in hideThinkingBlock).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PREVIEW_LINES = 3;
const MAX_PREVIEW_LINES = 500;

/** pi's answer to "how do I see the rest?" for collapsed tool output. */
const DEFAULT_EXPAND_HINT = "ctrl+o to expand";

/** How many finished blocks keep their measured duration (FIFO eviction). */
const TIMED_BLOCK_LIMIT = 64;

const AGENT_DIR = join(process.env.HOME ?? "", ".pi", "agent");
const STATE_PATH = join(AGENT_DIR, "thinking-preview.json");

/** The N chosen by the user, remembered across /reload and new sessions. */
export function loadSavedPreviewLines(): number | null {
	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
			previewLines?: unknown;
		};
		if (
			typeof parsed.previewLines === "number" &&
			Number.isInteger(parsed.previewLines) &&
			parsed.previewLines >= 0
		)
			return Math.min(parsed.previewLines, MAX_PREVIEW_LINES);
	} catch {
		// No saved state yet: fall back to the caller's default.
	}
	return null;
}

/** Persist N so /reload and the next session start from the same value. */
export function savePreviewLines(lines: number): void {
	try {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(
			STATE_PATH,
			`${JSON.stringify({ previewLines: lines }, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// Best effort only: a read-only home must not break the command.
	}
}

export function initialPreviewLines(): number {
	const raw = process.env.PI_THINKING_PREVIEW_LINES;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0)
			return Math.min(parsed, MAX_PREVIEW_LINES);
	}
	return loadSavedPreviewLines() ?? DEFAULT_PREVIEW_LINES;
}

/**
 * Read pi's own hideThinkingBlock setting straight from the settings layers
 * (project overrides global). The extension API exposes no getter, and when the
 * setting is true the renderer takes a Text() path that never consults markdown
 * transformers, so this preview would silently do nothing.
 */
function hideThinkingBlockEnabled(): boolean {
	const layers = [
		join(process.cwd(), ".pi", "settings.json"),
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

/** Shown when the built-in "hide" wins over this preview. */
function hiddenWarning(): string {
	return "thinking-preview: hideThinkingBlock=true 라 추론 블록이 통째로 접혀 미리보기가 안 보입니다. Ctrl+T로 펼치세요.";
}

/**
 * Force every already-rendered assistant message to re-render.
 *
 * The extension UI API has no redraw entry point, but pi's own
 * `setHiddenThinkingLabel` walks the whole transcript (plus the streaming
 * component) calling `updateContent` on each AssistantMessageComponent, which
 * re-runs the markdown transformers. Passing no label restores pi's default
 * label — exactly what pi itself does after a settings reload.
 */
function refreshTranscript(ctx: {
	ui: { setHiddenThinkingLabel: (label: string) => void };
}): void {
	// SAFETY: pi's setHiddenThinkingLabel resolves `label ?? defaultLabel`, so undefined is
	// the supported "reset to pi's default label" path it uses itself after a settings
	// reload. The published type just does not model the undefined case.
	ctx.ui.setHiddenThinkingLabel(undefined as unknown as string);
}

/** Same format pi uses for its tool-duration footer (e.g. "3.6s"). */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Hint text; override without editing code via PI_THINKING_PREVIEW_HINT. */
export function expandHint(): string {
	const raw = process.env.PI_THINKING_PREVIEW_HINT;
	return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_EXPAND_HINT;
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

		active = { key: markdown, startedAt: now, sawStreaming: true, durationMs: null };
		return null;
	};
}

/**
 * Build the markdown transformer the extension registers.
 *
 * pi runs the transformer list over EVERY assistant markdown part — the final
 * answer text included — so the `messageType` gate below is what keeps previews
 * and duration footers out of the response body. It is also what makes this
 * factory (rather than a raw arrow function) the thing tests exercise.
 *
 * `observe` is injectable so tests can supply deterministic durations.
 */
export function createThinkingTransformer(
	getPreviewLines: () => number,
	observe: (markdown: string, isStreaming: boolean) => number | null = createThinkingTiming(),
): (markdown: string, context: { messageType: string; isStreaming: boolean }) => string {
	return (markdown, context) => {
		if (context.messageType !== "assistant-thinking") return markdown;
		const durationMs = observe(markdown, context.isStreaming);
		return truncateThinking(markdown, getPreviewLines(), {
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
	if (options.durationMs !== undefined && options.durationMs !== null)
		parts.push(
			`${options.isStreaming ? "Elapsed" : "Took"} ${formatDuration(options.durationMs)}`,
		);

	return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	let previewLines = initialPreviewLines();

	pi.registerFlag("thinking-preview", {
		description: "Thinking preview lines for this run (0 = render full thinking)",
		type: "string",
	});

	const flagValue = pi.getFlag("thinking-preview");
	if (typeof flagValue === "string" && flagValue.trim() !== "") {
		const parsed = Number.parseInt(flagValue, 10);
		if (Number.isFinite(parsed) && parsed >= 0)
			previewLines = Math.min(parsed, MAX_PREVIEW_LINES);
	}

	pi.registerMarkdownTransformer(createThinkingTransformer(() => previewLines));

	pi.registerCommand("thinking-preview", {
		description:
			"Show the last N lines of thinking blocks plus a 'Took Xs' footer. Usage: /thinking-preview [n|off]",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();

			if (!raw) {
				ctx.ui.notify(
					previewLines > 0
						? `추론 미리보기: 마지막 ${previewLines}줄 + 걸린 시간 (전체 보기: /thinking-preview off)`
						: "추론 미리보기: 끔 (추론 전체 표시)",
				);
				if (previewLines > 0 && hideThinkingBlockEnabled())
					ctx.ui.notify(hiddenWarning(), "warning");
				return;
			}

			if (raw === "off" || raw === "full" || raw === "0") {
				previewLines = 0;
				savePreviewLines(0);
				refreshTranscript(ctx);
				ctx.ui.notify(
					"추론 미리보기: 끔 (추론 전체 표시) — 지나간 블록도 다시 그렸습니다.",
				);
				return;
			}

			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed) || parsed < 1) {
				ctx.ui.notify(
					`잘못된 값 '${raw}'. 1-${MAX_PREVIEW_LINES} 사이 숫자 또는 'off'를 쓰세요.`,
					"warning",
				);
				return;
			}

			previewLines = Math.min(parsed, MAX_PREVIEW_LINES);
			savePreviewLines(previewLines);
			refreshTranscript(ctx);
			ctx.ui.notify(
				`추론 미리보기: 마지막 ${previewLines}줄 — 지나간 블록까지 즉시 다시 그렸습니다.`,
			);
			if (hideThinkingBlockEnabled()) ctx.ui.notify(hiddenWarning(), "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const hidden = previewLines > 0 && hideThinkingBlockEnabled();
		let status = "thinking:full";
		if (hidden) status = "thinking:hidden";
		else if (previewLines > 0) status = `thinking≤${previewLines}l`;
		ctx.ui.setStatus("thinking-preview", status);
		if (hidden) ctx.ui.notify(hiddenWarning(), "warning");
	});
}
