// One headless suite for the simple thinking-preview extension: pure logic, level parsing,
// state precedence, event wiring (real matchesKey + a fake pi/ui) and a real component render.
// No TUI, no model, no writes outside a temp $HOME.
import { DIST } from "./pi-root.mjs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// $HOME must be redirected before the import: the extension derives its state path at load.
const HOME = process.env.TP_TEST_HOME ?? join(tmpdir(), "pi-thinking-preview-test");
const STATE = join(HOME, ".pi", "agent", "thinking-preview.json");
process.env.HOME = HOME;
delete process.env.PI_THINKING_PREVIEW_VIEW;
delete process.env.PI_THINKING_PREVIEW_LINES;
delete process.env.PI_THINKING_PREVIEW_HINT;
delete process.env.PI_CODING_AGENT_DIR;
rmSync(STATE, { force: true });

const {
	default: register,
	truncateThinking,
	parseViewSpec,
	nextView,
	clampLines,
	createThinkingTransformer,
	resolveInitialState,
	saveState,
	loadSavedState,
} = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};
const section = (label) => console.log(`\n── ${label}`);

const HINT = "ctrl+t to cycle";
const hint = (n) => `... (${n} earlier line${n === 1 ? "" : "s"}, ${HINT})`;

// ── A. truncateThinking ───────────────────────────────────────────────────────────────
section("truncateThinking");
check("a block within the budget is untouched", truncateThinking("a\nb", 5) === "a\nb");
check(
	"the tail is the last N lines",
	truncateThinking("l1\nl2\nl3\nl4", 2) === `${hint(2)}\nl3\nl4`,
);
check(
	"the hint is singular for one line",
	truncateThinking("a\nb", 1) === `${hint(1)}\nb`,
);
check(
	"blank separators are not reasoning",
	truncateThinking("l1\n\n\n\n\nl2", 1) === `${hint(1)}\nl2`,
	JSON.stringify(truncateThinking("l1\n\n\n\n\nl2", 1)),
);
check(
	"blank separators inside the tail are kept",
	truncateThinking("a\n\nb\n\nc", 2) === `${hint(1)}\nb\n\nc`,
	JSON.stringify(truncateThinking("a\n\nb\n\nc", 2)),
);
check("maxLines 0 disables the preview", truncateThinking("a\nb", 0) === "a\nb");
check("empty input stays empty", truncateThinking("", 3) === "");
check("trailing whitespace is trimmed", truncateThinking("a\nb\n\n\n", 1) === `${hint(1)}\nb`);

const long = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join("\n");
const tail = truncateThinking(long, 5);
check(
	"5 lines of reasoning follow the hint",
	tail === `${hint(25)}\nstep 26\nstep 27\nstep 28\nstep 29\nstep 30`,
	JSON.stringify(tail),
);
check(
	"a wrapped long line still counts as one line",
	truncateThinking(`${"x".repeat(400)}\nsecond`, 1) === `${hint(1)}\nsecond`,
);

// ── B. level specs ────────────────────────────────────────────────────────────────────
section("level specs");
const view = (raw) => parseViewSpec(raw)?.view ?? null;
check("view names parse", ["full", "preview", "hidden"].every((v) => view(v) === v));
check("aliases", view("off") === "full" && view("on") === "preview" && view("hide") === "hidden");
check("0 is the hidden level", view("0") === "hidden");
check("a number is a preview budget", parseViewSpec("7").view === "preview" && parseViewSpec("7").lines === 7);
check("padding and case are ignored", parseViewSpec("  PREVIEW ").view === "preview");
check("junk is rejected", view("nope") === null && parseViewSpec("") === null);
check("the budget is clamped", clampLines(9999) === 500 && clampLines(0) === 1);
check("Ctrl+T cycles full -> preview -> hidden -> full", nextView("full") === "preview" && nextView("preview") === "hidden" && nextView("hidden") === "full");

// ── C. persistence and precedence ─────────────────────────────────────────────────────
section("state");
saveState({ view: "full", lines: 9 });
check("state round-trips", JSON.stringify(loadSavedState()) === '{"view":"full","lines":9}');
delete process.env.PI_THINKING_PREVIEW_VIEW;
check("saved state beats the default", resolveInitialState({}).view === "full");
check(
	"env view keeps the saved line count",
	JSON.stringify(resolveInitialState({ PI_THINKING_PREVIEW_VIEW: "hidden" })) ===
		'{"view":"hidden","lines":9}',
);
check(
	"env lines wins",
	JSON.stringify(resolveInitialState({ PI_THINKING_PREVIEW_LINES: "2" })) ===
		'{"view":"preview","lines":2}',
);
check("junk env is ignored", resolveInitialState({ PI_THINKING_PREVIEW_VIEW: "?" }).view === "full");

// ── D. event wiring through a fake pi/ui ──────────────────────────────────────────────
section("wiring");
const handlers = new Map();
const commands = new Map();
let registered = null;
register({
	registerFlag: () => {},
	getFlag: () => undefined,
	registerMarkdownTransformer: (fn) => {
		registered = fn;
	},
	registerCommand: (name, options) => commands.set(name, options),
	on: (event, handler) => handlers.set(event, handler),
});
check("a markdown transformer and the command are registered", registered !== null && commands.has("thinking-preview"));

const notified = [];
const inputs = [];
const unsubscribed = [];
const ui = {
	notify: (message, type) => notified.push([type, message]),
	setHiddenThinkingLabel: () => {},
	onTerminalInput: (handler) => {
		inputs.push(handler);
		const index = inputs.length - 1;
		return () => unsubscribed.push(index);
	},
};
const ctx = { ui };

const command = commands.get("thinking-preview").handler;
const text = "step 1\nstep 2\nstep 3\nstep 4\nstep 5\nstep 6\nstep 7";
const think = () => registered(text, { messageType: "assistant-thinking" });
const previewText = `${hint(2)}\nstep 3\nstep 4\nstep 5\nstep 6\nstep 7`;

await command("5", ctx);
check("the command arms preview with the requested budget", think() === previewText, JSON.stringify(think()));
check("the command saved the level", JSON.stringify(loadSavedState()) === '{"view":"preview","lines":5}');

await handlers.get("session_start")({}, ctx);
check("session_start installs the input handler", inputs.length === 1);
check("ctrl+o and literal text are not consumed", inputs[0]("\x0f") === undefined && inputs[0]("ctrl+t") === undefined);
check("ctrl+t (0x14) is consumed", JSON.stringify(inputs[0]("\x14")) === '{"consume":true}');
check("one press moves preview -> hidden", think() === "Thinking...");
inputs[0]("\x14");
check("the next press moves hidden -> full", think() === text);
inputs[0]("\x14");
check("the next press wraps full -> preview", think() === previewText);
check("the answer text is still left alone", registered("Answer: 391", { messageType: "assistant" }) === "Answer: 391");

await command("5", ctx);
await handlers.get("session_start")({}, ctx);
check("re-registering unsubscribes the old handler", unsubscribed.includes(0));
check("one press on the live handler advances one level", inputs[1]?.("\x14").consume === true && think() === "Thinking...");

await command("full", ctx);
check("a bare level name keeps the budget", loadSavedState().lines === 5);
check("full shows the whole block", think() === text);
await command("nope", ctx);
check("junk is reported as a warning", notified.some(([type]) => type === "warning") && loadSavedState().view === "full");

// ── E. real render through pi's component ─────────────────────────────────────────────
section("render");
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
initTheme("dark", false);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const thinking = Array.from({ length: 30 }, (_, i) => `step ${i + 1}: reasoning`).join("\n\n");
const message = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking },
		{ type: "text", text: "Answer: 391" },
	],
};
const state = { view: "preview", lines: 3 };
const render = () =>
	strip(
		new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			createThinkingTransformer(() => state),
		])
			.render(100)
			.join("\n"),
	);

const preview = render();
check("preview renders the hint and the newest steps", preview.includes(hint(27)) && preview.includes("step 30") && preview.includes("step 28"));
check("preview drops the head", !preview.includes("step 27:"));
check("preview keeps the answer", preview.includes("391"));
check("the hint sits directly above the tail", preview.split("\n").findIndex((l) => l.includes(hint(27))) + 1 === preview.split("\n").findIndex((l) => l.includes("step 28:")));

state.view = "hidden";
const hidden = render();
check("hidden renders only the label", hidden.includes("Thinking...") && !hidden.includes("step 1") && hidden.includes("391"));

state.view = "full";
const full = render();
check("full renders the whole block", full.includes("step 1:") && full.includes("step 30:") && full.includes("391"));
check("preview is shorter than full", preview.split("\n").length < full.split("\n").length);

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
