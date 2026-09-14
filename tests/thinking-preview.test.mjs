// Headless suite for the simple thinking-preview extension: the pure head-preview function, the
// thinking gate, the registration wiring, and a real render through pi's AssistantMessageComponent.
import { DIST } from "./pi-root.mjs";

const {
	previewThinking,
	isThinkingContext,
	VISIBLE_LINES,
	default: register,
} = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const blocks = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const hint = (n) => `... ${n} more line${n === 1 ? "" : "s"} hidden`;

check("five lines show", VISIBLE_LINES === 5);

const long = previewThinking(blocks.join("\n"));
check(
	"the head is exactly 5 lines under the hint",
	long === `${blocks.slice(0, 5).join("\n")}\n\n${hint(7)}`,
	JSON.stringify(long),
);
check("line 6 onwards is gone", !long.includes("line 6"));

const short = "a\nb\nc";
check("a block that fits is untouched", previewThinking(short) === short);
check("blank separators are not reasoning", previewThinking("a\n\n\n\n\n\nb") === "a\n\n\n\n\n\nb");
check(
	"blank lines inside the head are kept",
	previewThinking("l1\n\nl2\nl3\nl4\nl5\n\nl6\nl7") === `l1\n\nl2\nl3\nl4\nl5\n\n${hint(2)}`,
	JSON.stringify(previewThinking("l1\n\nl2\nl3\nl4\nl5\n\nl6\nl7")),
);
check("one hidden line reads singular", previewThinking("a\nb\nc\nd\ne\nf") === `a\nb\nc\nd\ne\n\n${hint(1)}`);
check("empty input stays empty", previewThinking("") === "");
check("maxLines 0 disables the preview", previewThinking("a\nb", 0) === "a\nb");
check("a custom budget works", previewThinking(blocks.join("\n"), 2) === `${blocks.slice(0, 2).join("\n")}\n\n${hint(10)}`);
check("the gate matches thinking only", isThinkingContext({ messageType: "assistant-thinking" }) && isThinkingContext({ kind: "thinking" }) && !isThinkingContext({ messageType: "assistant" }));

// Registration: one transformer, thinking-only.
let transformer = null;
register({ registerMarkdownTransformer: (fn) => { transformer = fn; } });
check("a transformer is registered", typeof transformer === "function");
check("thinking is previewed", transformer(blocks.join("\n"), { messageType: "assistant-thinking" }) === long);
check("the answer is left alone", transformer("Answer: 42", { messageType: "assistant", isStreaming: false }) === "Answer: 42");

// Real render, exactly the arguments interactive-mode passes.
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
initTheme("dark", false);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
if (typeof transformer === "function") {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: blocks.join("\n\n") },
			{ type: "text", text: "Answer: 42" },
		],
	};
	const lines = strip(
		new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [transformer])
			.render(100)
			.join("\n"),
	);
	const shown = lines.split("\n").filter((l) => l.includes("line ")).length;
	check("the render shows five lines of reasoning", shown === 5, `shown=${shown}`);
	check("the render shows the hint", lines.includes(hint(7)));
	check("the render shows the answer", lines.includes("Answer: 42"));
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
