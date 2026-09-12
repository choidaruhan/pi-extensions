/**
 * Thinking Preview Extension
 *
 * Instead of hiding reasoning blocks completely (`hideThinkingBlock: true`) or
 * dumping every line of them, show a short preview: the first N lines of the
 * thinking block followed by a `... (X more lines)` hint.
 *
 * Defaults:
 *   N = 3 lines, override at load time with PI_THINKING_PREVIEW_LINES=<n>
 *   or per run with --thinking-preview <n>
 *
 * Commands:
 *   /thinking-preview            show current setting
 *   /thinking-preview <n>        preview first <n> lines (1-500)
 *   /thinking-preview off        disable truncation (render full thinking)
 *
 * Notes:
 *   - Applies to rendered output only; model context is untouched.
 *   - Ctrl+T still hides thinking blocks entirely (built-in setting
 *     hideThinkingBlock), so this extension is about the *visible* state.
 *   - When hideThinkingBlock is true the renderer takes a Text() path that never
 *     consults markdown transformers, so this preview cannot run; the extension
 *     warns at session start in that case.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PREVIEW_LINES = 3;
const MAX_PREVIEW_LINES = 500;

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

/**
 * Truncate thinking markdown to `maxLines` non-blank lines, appending a hint that
 * reports how many non-blank lines were dropped. Blank lines used as paragraph
 * separators travel with the lines around them, so the budget matches what a
 * reader counts on screen. `maxLines = 0` disables truncation.
 */
export function truncateThinking(markdown: string, maxLines: number): string {
	if (maxLines <= 0) return markdown;

	const lines = markdown.replace(/\s+$/, "").split("\n");
	const totalLines = lines.filter((line) => line.trim() !== "").length;
	if (totalLines <= maxLines) return markdown;

	let seen = 0;
	let cutIndex = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		seen++;
		if (seen === maxLines) {
			cutIndex = i + 1;
			break;
		}
	}

	let shown = lines.slice(0, cutIndex).join("\n").replace(/\s+$/, "");
	const remaining = totalLines - maxLines;

	// A dangling code fence would swallow the hint line (and look broken), so close it.
	const fenceCount = (shown.match(/^\s*```/gm) ?? []).length;
	if (fenceCount % 2 === 1) shown += "\n```";

	return `${shown}\n\n... (${remaining} more ${remaining === 1 ? "line" : "lines"}, ${totalLines} total, Ctrl+T to hide)`;
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

	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		return truncateThinking(markdown, previewLines);
	});

	pi.registerCommand("thinking-preview", {
		description:
			"Show N lines of thinking blocks, then '... (X more lines)'. Usage: /thinking-preview [n|off]",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();

			if (!raw) {
				ctx.ui.notify(
					previewLines > 0
						? `추론 미리보기: 앞 ${previewLines}줄 (전체 보기: /thinking-preview off)`
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
				`추론 미리보기: 앞 ${previewLines}줄 — 지나간 블록까지 즉시 다시 그렸습니다.`,
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
