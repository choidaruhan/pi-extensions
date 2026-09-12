// End-to-end wiring for the Ctrl+T level cycler: the extension's real
// session_start handler, the real matchesKey parser, and a fake pi/ui — no TUI,
// no model, no writes outside a temp $HOME.
import "./pi-root.mjs";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME =
	process.env.TP_TEST_HOME ?? join(tmpdir(), "pi-extensions-ctrl-t-test");
process.env.HOME = HOME;
delete process.env.PI_THINKING_PREVIEW_VIEW;
delete process.env.PI_THINKING_PREVIEW_LINES;
const statePath = join(HOME, ".pi", "agent", "thinking-preview.json");
rmSync(statePath, { force: true });

const { default: register } = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

const handlers = new Map();
const commands = new Map();
const transformers = [];
const flags = new Map();
const pi = {
	registerFlag: (name, spec) => flags.set(name, spec),
	getFlag: () => undefined,
	registerMarkdownTransformer: (t) => transformers.push(t),
	registerCommand: (name, spec) => commands.set(name, spec),
	on: (event, handler) => handlers.set(event, handler),
};

const calls = { notify: [], status: [], refresh: 0, unsubscribed: 0 };
let inputHandler;
const ctx = {
	ui: {
		notify: (message, type = "info") => calls.notify.push(`${type}: ${message}`),
		setStatus: (key, text) => calls.status.push(`${key}=${text}`),
		setHiddenThinkingLabel: () => {
			calls.refresh++;
		},
		onTerminalInput: (handler) => {
			inputHandler = handler;
			return () => {
				calls.unsubscribed++;
			};
		},
	},
};

register(pi);
check("registers a markdown transformer", transformers.length === 1);
check(
	"registers the /thinking-preview command",
	commands.has("thinking-preview"),
);
check("registers the --thinking-preview flag", flags.has("thinking-preview"));

const transform = (markdown, messageType = "assistant-thinking") =>
	transformers[0](markdown, { messageType, isStreaming: false });
const think = (n) =>
	Array.from({ length: n }, (_, i) => `step ${i + 1}`).join("\n\n");
const level = (markdown) => {
	const out = transform(markdown);
	if (out === "Thinking...") return "hidden";
	if (out.includes("earlier line"))
		return `preview(${out.match(/(\d+) earlier/)[1]})`;
	return "full";
};

await handlers.get("session_start")({}, ctx);
check(
	"session_start installs an input handler",
	typeof inputHandler === "function",
);
check(
	"session_start sets no status line",
	calls.status.length === 0,
	calls.status.join(", "),
);
check(
	"default level previews within 3 rows",
	level(think(30)) === "preview(29)",
);

// Ctrl+T walks full -> preview -> hidden -> full; from the default it hides first.
const press = () => inputHandler("\x14");
check("ctrl+t is consumed", press()?.consume === true);
check("1st press hides thinking", level(think(30)) === "hidden");
check(
	"saved state follows the press",
	JSON.parse(readFileSync(statePath, "utf8")).view === "hidden",
	readFileSync(statePath, "utf8").trim().replace(/\s+/g, " "),
);
check(
	"2nd press shows the whole block",
	press()?.consume === true && level(think(30)) === "full",
	level(think(30)),
);
check(
	"3rd press returns to the preview",
	press()?.consume === true && level(think(30)) === "preview(29)",
);
check(
	"each press refreshed the transcript",
	calls.refresh >= 3,
	`${calls.refresh} refreshes`,
);
check(
	"no press sets a status line either",
	calls.status.length === 0,
	calls.status.join(", "),
);

// Everything that is not ctrl+t must reach pi untouched.
check("ctrl+o is not consumed", inputHandler("\x0f") === undefined);
check("plain text is not consumed", inputHandler("a") === undefined);
check(
	"ctrl+t with trailing bytes is not consumed",
	inputHandler("\x14abc") === undefined,
);
check("alt+t is not consumed", inputHandler("\x1bt") === undefined);
check("no other key changed the level", level(think(30)) === "preview(29)");

// Answer text must stay pristine on every level.
for (const messageType of ["assistant", "user"]) {
	check(
		`${messageType} text is untouched`,
		transform("Took 3.6s, but this is just an answer", messageType) ===
			"Took 3.6s, but this is just an answer",
	);
}

// The command mirrors the cycle, including explicit line counts.
await commands.get("thinking-preview").handler("full", ctx);
check("command full", level(think(30)) === "full");
await commands.get("thinking-preview").handler("5", ctx);
check("command 5 lines", level(think(30)) === "preview(28)");
check(
	"command echoed the level",
	calls.notify.at(-1).includes("preview (높이 5줄)"),
	calls.notify.at(-1),
);
await commands.get("thinking-preview").handler("hidden", ctx);
check("command hidden", level(think(30)) === "hidden");
await commands.get("thinking-preview").handler("preview", ctx);
check(
	"command preview keeps the last line count",
	level(think(30)) === "preview(28)",
);
await commands.get("thinking-preview").handler("bogus", ctx);
check(
	"command rejects junk",
	calls.notify.at(-1).startsWith("warning:") &&
		level(think(30)) === "preview(28)",
	calls.notify.at(-1),
);
await commands.get("thinking-preview").handler("", ctx);
check(
	"bare command reports the level",
	calls.notify.at(-1).includes("preview (높이 5줄)"),
	calls.notify.at(-1),
);

// A second session (session switch) must not stack input handlers.
await handlers.get("session_start")({}, ctx);
check("old input handler was unsubscribed", calls.unsubscribed === 1);
const beforeStacked = level(think(30));
press();
check(
	"one press advances exactly one level",
	level(think(30)) !== beforeStacked,
);

await handlers.get("session_shutdown")({}, ctx);
check("shutdown unsubscribes", calls.unsubscribed === 2);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
