#!/usr/bin/env node
// Write a fabricated pi session and print its path.
//
// `pi --session <file>` replays a transcript without starting a turn, so the real TUI renders the
// thinking block through the extension's transformer — the only honest way to see what the
// transformer draws, with no model call and no tokens. pi appends session state to whatever file it
// opens, so this always writes a fresh copy under the temp dir instead of a repo-tracked fixture.
//
//   d=$(node tools/make-pty-fixture.mjs)
//   PI_OFFLINE=1 tools/pty-keys.py "" 8 4 -- pi --session "$d" -e ./extensions/thinking-preview.ts
//
// With the default 5-line budget the screen must show the first 5 reasoning lines, then
// "... 20 more lines hidden", then the answer text.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REASONING_LINES = 25;
const ANSWER = "Final answer: 42.";

const ordinal = (n) => {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

const timestamp = new Date().toISOString();
const reasoning = Array.from(
	{ length: REASONING_LINES },
	(_, i) => `reasoning step ${i + 1}: checking the ${ordinal(i + 1)} candidate`,
).join("\n");

const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message });

const lines = [
	{
		type: "session",
		version: 3,
		id: "00000000-0000-4000-8000-000000000000",
		timestamp,
		cwd: process.cwd(),
	},
	entry("u1", null, {
		role: "user",
		content: [{ type: "text", text: "Explain, briefly." }],
	}),
	entry("a1", "u1", {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: reasoning, thinkingSignature: "" },
			{ type: "text", text: ANSWER },
		],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture/fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: Date.now(),
		responseId: "fixture",
		rawStopReason: "tool_calls",
	}),
];

const dir = mkdtempSync(join(tmpdir(), "pi-pty-fixture-"));
const path = join(dir, "session.jsonl");
writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
console.log(path);
