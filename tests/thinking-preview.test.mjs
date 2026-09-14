// Headless suite for the thinking-preview extension: the three levels, the Ctrl+T cycle through a
// fake pi/ui with pi's real key matcher, and a real render through pi's AssistantMessageComponent.
import { DIST } from "./pi-root.mjs";

const {
	promptThinking,
	isThinkingContext,
	nextView,
	CYCLE,
	VISIBLE_LINES,
	default: register,
} = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const blocks = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const long = blocks.join("\n");
const hint = (n) => `... ${n} more line${n === 1 ? "" : "s"} hidden (ctrl+t)`;
const thinking = { messageType: "assistant-thinking" };
const answer = { messageType: "assistant" };

// ---- levels -----------------------------------------------------------------------------------
check("the preview keeps five lines", VISIBLE_LINES === 5);
check("preview keeps the head", promptThinking(long, "preview") === `${blocks.slice(0, 5).join("\n")}\n\n${hint(7)}`);
check("preview drops the tail", !promptThinking(long, "preview").includes("line 6"));
check("full is untouched", promptThinking(long, "full") === long);
check("full keeps a huge block", promptThinking(`${long}\n${long}`, "full").split("\n").length === 24);
check("hidden is one label", promptThinking(long, "hidden") === "Thinking...");
check("hidden ignores empty input", promptThinking("", "hidden") === "Thinking...");
check("a block that fits is untouched", promptThinking("a\nb\nc", "preview") === "a\nb\nc");
check("blank separators are not reasoning", promptThinking("a\n\n\n\n\n\nb", "preview") === "a\n\n\n\n\n\nb");
check(
	"blanks inside the head are kept",
	promptThinking("l1\n\nl2\nl3\nl4\nl5\n\nl6\nl7", "preview") === `l1\n\nl2\nl3\nl4\nl5\n\n${hint(2)}`,
);
check("one hidden line reads singular", promptThinking("a\nb\nc\nd\ne\nf", "preview") === `a\nb\nc\nd\ne\n\n${hint(1)}`);
check("empty input stays empty", promptThinking("", "preview") === "");
check("maxLines 0 disables the preview", promptThinking("a\nb", "preview", 0) === "a\nb");
check("a custom budget works", promptThinking(long, "preview", 2) === `${blocks.slice(0, 2).join("\n")}\n\n${hint(10)}`);
check("the gate matches thinking only", isThinkingContext(thinking) && isThinkingContext({ kind: "thinking" }) && !isThinkingContext(answer));

// ---- cycle ------------------------------------------------------------------------------------
check("the cycle is preview, full, hidden", CYCLE.join(",") === "preview,full,hidden");
check("preview cycles to full", nextView("preview") === "full");
check("full cycles to hidden", nextView("full") === "hidden");
check("hidden wraps to preview", nextView("hidden") === "preview");

// ---- wiring -----------------------------------------------------------------------------------
let transformer = null;
const sessions = [];
register({
	registerMarkdownTransformer: (fn) => { transformer = fn; },
	on: (event, handler) => { if (event === "session_start" || event === "session_shutdown") sessions.push([event, handler]); },
});
const start = sessions.find(([event]) => event === "session_start")?.[1];
const shutdown = sessions.find(([event]) => event === "session_shutdown")?.[1];
check("a transformer and both session handlers are registered", typeof transformer === "function" && typeof start === "function" && typeof shutdown === "function");

const fakeCtx = () => {
	const ui = { redraws: [], handlers: [] };
	return {
		ui,
		ctx: {
			ui: {
				onTerminalInput: (fn) => {
					ui.handlers.push(fn);
					return () => { fn.stopped = true; };
				},
				setHiddenThinkingLabel: (...args) => { ui.redraws.push(args); },
			},
		},
	};
};

const first = fakeCtx();
await start({}, first.ctx);
const press = () => first.ui.handlers.at(-1)("\x14");
check("ctrl+t is consumed", press()?.consume === true);
check("ctrl+t redraws every block", first.ui.redraws.length === 1);
check("the redraw passes no label", first.ui.redraws[0].length === 0);
check("the answer is never transformed", transformer("Answer: 42", answer) === "Answer: 42");
check("ctrl+t moved preview to full", transformer(long, thinking) === long);
press();
check("the second press hides thinking", transformer(long, thinking) === "Thinking...");
press();
check("the third press wraps to preview", transformer(long, thinking) === `${blocks.slice(0, 5).join("\n")}\n\n${hint(7)}`);
check("a neighbouring key is left alone", first.ui.handlers.at(-1)("\x0f") === undefined && first.ui.redraws.length === 3);

// A session switch re-registers; the old subscription must be dropped or one press advances twice.
const second = fakeCtx();
await start({}, second.ctx);
check("the old input handler is unsubscribed", first.ui.handlers.at(-1).stopped === true);
second.ui.handlers.at(-1)("\x14");
check("one press advances exactly one level", transformer(long, thinking) === long);
await shutdown({}, second.ctx);
check("shutdown drops the handler too", second.ui.handlers.at(-1).stopped === true);

// ---- real render, one per level ---------------------------------------------------------------
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
initTheme("dark", false);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const reasoning = Array.from({ length: 25 }, (_, i) => `reasoning step ${i + 1}`);
const message = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: reasoning.join("\n\n") },
		{ type: "text", text: "Answer: 42" },
	],
};
// A fresh component per level: an already-rendered one keeps its output until updateContent.
const seen = () => {
	const text = strip(new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [transformer]).render(100).join("\n"));
	return { text, shown: text.split("\n").filter((l) => l.includes("reasoning step")).length };
};

const view = fakeCtx();
await start({}, view.ctx);
// The level is module state shared with the sections above, so read where it sits instead of
// assuming: this also asserts that the transformer agrees with the level the cycle reports.
const level = () => {
	const out = transformer(long, thinking);
	if (out === long) return "full";
	return out === "Thinking..." ? "hidden" : "preview";
};
const pressRender = () => view.ui.handlers.at(-1)("\x14");
while (level() !== "preview") pressRender();

const preview = seen();
check("preview renders five reasoning lines", preview.shown === 5, `shown=${preview.shown}`);
check("preview renders the hint", preview.text.includes(hint(20)));
check("preview keeps the answer", preview.text.includes("Answer: 42"));
pressRender();
check("the second level is full", level() === "full");
const full = seen();
check("full renders every reasoning line", full.shown === 25, `shown=${full.shown}`);
check("full renders no hint", !full.text.includes("more line"));
pressRender();
check("the third level is hidden", level() === "hidden");
const hidden = seen();
check("hidden renders no reasoning", hidden.shown === 0, `shown=${hidden.shown}`);
check("hidden renders the label", hidden.text.includes("Thinking..."));
check("hidden keeps the answer", hidden.text.includes("Answer: 42"));
pressRender();
check("the cycle wraps back to preview", level() === "preview");

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);