// Side-effect import: links pi's bundled @earendil-works/pi-tui into
// node_modules so the extension's bare specifier resolves under plain node.
import "./pi-root.mjs";

const {
	truncateThinking,
	formatDuration,
	createThinkingTiming,
	createThinkingTransformer,
	expandHint,
	hiddenLabel,
	thinkingFooter,
	parseViewSpec,
	nextView,
	isThinkingContext,
	THINKING_VIEWS,
	DEFAULT_STATE,
} = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

const think = (n) =>
	Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n\n");

const HINT = "ctrl+t to cycle";

// 1) a block shorter than N keeps every line, but still reports its duration
const short = truncateThinking(think(3), 5, { durationMs: 3600 });
check(
	"short block keeps every line",
	short.includes("line 1") && short.includes("line 3"),
);
check("short block has no hint", !short.includes("earlier line"));
check("short block still gets the footer", short.trimEnd().endsWith("Took 3.6s"));

// 2) a long block shows the tail (most recent reasoning), hint above, footer below
const long = truncateThinking(think(30), 5, { durationMs: 3600 });
const longLines = long.split("\n");
check(
	"hint is the first line",
	longLines[0] === `... (25 earlier lines, ${HINT})`,
	longLines[0],
);
check("head lines are dropped", !long.includes("line 25"));
check("tail lines are kept", long.includes("line 26") && long.includes("line 30"));
check(
	"footer is the last line",
	longLines[longLines.length - 1] === "Took 3.6s",
	longLines[longLines.length - 1],
);
check(
	"hint/body/footer separated by blank lines",
	/\n\nline 26/.test(long) && /\n\nTook/.test(long),
);
check("no blank-line pile-up", !/\n\n\n/.test(long));

// 3) singular wording, zero-line mode, footer labels
check(
	"singular hint for one dropped line",
	truncateThinking(think(2), 1) === `... (1 earlier line, ${HINT})\n\nline 2`,
);
check(
	"blank separators do not leak into the tail",
	truncateThinking("l1\n\n\nl2", 1) === `... (1 earlier line, ${HINT})\n\nl2`,
);
check(
	"maxLines=0 returns the markdown untouched",
	truncateThinking(think(5), 0, { durationMs: 1000 }) === think(5),
);
check(
	"streaming footer says Elapsed",
	truncateThinking(think(30), 1, {
		durationMs: 2100,
		isStreaming: true,
	}).endsWith("Elapsed 2.1s"),
);
check(
	"no footer without a duration",
	!truncateThinking(think(30), 1).includes("Took"),
);
check("thinkingFooter() is null without a duration", thinkingFooter() === null);
check(
	"thinkingFooter() formats a finished block",
	thinkingFooter({ durationMs: 3600 }) === "Took 3.6s",
);

// 4) an unclosed code fence in the tail is closed before the footer
const fenced = truncateThinking("```js\ncode 1\ncode 2\ncode 3\ncode 4\n```", 2, {
	durationMs: 900,
});
check(
	"dangling fence is closed",
	fenced.includes("code 4\n```\n```\n\nTook 0.9s"),
	JSON.stringify(fenced),
);

// 5) duration formatting matches pi's bash footer
check("formatDuration(3600) is 3.6s", formatDuration(3600) === "3.6s");
check("formatDuration(0) is 0.0s", formatDuration(0) === "0.0s");
check("formatDuration(65000) is 65.0s", formatDuration(65000) === "65.0s");

// 6) hint/label text overrides
process.env.PI_THINKING_PREVIEW_HINT = "press X to expand";
check(
	"env overrides the hint",
	expandHint() === "press X to expand" &&
		truncateThinking(think(3), 1).includes("press X to expand"),
);
delete process.env.PI_THINKING_PREVIEW_HINT;
process.env.PI_THINKING_HIDDEN_LABEL = "*thinking*";
check(
	"env overrides the hidden label",
	hiddenLabel() === "*thinking*",
);
delete process.env.PI_THINKING_HIDDEN_LABEL;
check("default hidden label matches pi's", hiddenLabel() === "Thinking...");

// 7) duration tracking across streaming renders
const observe = createThinkingTiming();
check(
	"streaming block has no duration yet",
	observe("hello", true, 1000) === null,
);
check("growing block keeps measuring", observe("hello world", true, 2000) === null);
check(
	"final render reports the elapsed time",
	observe("hello world done", false, 4600) === 3600,
);
check(
	"re-render keeps the measured time",
	observe("hello world done", false, 9000) === 3600,
);
observe("another block", true, 10000);
check(
	"a previous block still resolves via the cache",
	observe("hello world done", false, 11000) === 3600,
);
check(
	"a block never seen streaming has no timing",
	observe("restored from disk", false, 12000) === null,
);
check(
	"that block does not clobber the active timer",
	observe("another block grows", true, 13000) === null,
);
check(
	"the active block still measures its own span",
	observe("another block grows more", false, 15000) === 5000,
);

// 8) transformer wiring: only thinking parts are touched, isStreaming is forwarded
const state = { value: { view: "preview", lines: 1 } };
const transformer = createThinkingTransformer(
	() => state.value,
	(_markdown, isStreaming) => (isStreaming ? 2100 : 3600),
);
const ANSWER = "Took nothing here, just the answer.";
check(
	"answer text is passed through untouched",
	transformer(ANSWER, { messageType: "assistant", isStreaming: false }) ===
		ANSWER,
);
check(
	"thinking parts are previewed",
	transformer(think(30), {
		messageType: "assistant-thinking",
		isStreaming: false,
	}).includes("29 earlier lines"),
);
check(
	"streaming thinking parts show Elapsed",
	transformer(think(30), {
		messageType: "assistant-thinking",
		isStreaming: true,
	}).endsWith("Elapsed 2.1s"),
);
state.value = { view: "preview", lines: 4 };
check(
	"the transformer reads the line count live",
	transformer(think(30), {
		messageType: "assistant-thinking",
		isStreaming: false,
	}).includes("26 earlier lines"),
);

// 9) the three display levels
state.value = { view: "hidden", lines: 4 };
check(
	"hidden view renders only the label",
	transformer(think(30), {
		messageType: "assistant-thinking",
		isStreaming: false,
	}) === "Thinking...",
);
check(
	"hidden view still ignores answer text",
	transformer(ANSWER, { messageType: "assistant", isStreaming: false }) ===
		ANSWER,
);

state.value = { view: "full", lines: 4 };
const full = transformer(think(30), {
	messageType: "assistant-thinking",
	isStreaming: false,
});
check(
	"full view keeps every line",
	full.includes("line 1") && full.includes("line 30"),
);
check("full view has no hint", !full.includes("earlier"));
check("full view keeps the footer", full.trimEnd().endsWith("Took 3.6s"));
check("full view does not stack blank lines", !/\n\n\n/.test(full));
check(
	"full view with no measured duration is byte-identical",
	createThinkingTransformer(
		() => ({ view: "full", lines: 4 }),
		() => null,
	)(think(3), { messageType: "assistant-thinking", isStreaming: false }) ===
		think(3),
);

// 10) the thinking gate accepts both context shapes pi has used
check(
	"messageType=assistant-thinking is thinking",
	isThinkingContext({ messageType: "assistant-thinking" }),
);
check("kind=thinking is thinking", isThinkingContext({ kind: "thinking" }));
check("kind=text is not thinking", !isThinkingContext({ kind: "text" }));
check(
	"a kind=text part survives the preview view",
	transformer(think(30), { kind: "text", isStreaming: false }) === think(30),
);

// 11) view specs (flag, env and command share this parser)
check(
	"level order is full -> preview -> hidden",
	THINKING_VIEWS.join(",") === "full,preview,hidden",
);
check("default state is the 3-line preview", DEFAULT_STATE.view === "preview");
const cycle = [DEFAULT_STATE.view];
for (let i = 0; i < 3; i++) cycle.push(nextView(cycle[cycle.length - 1]));
check(
	"ctrl+T order from the default level",
	cycle.join(" ") === "preview hidden full preview",
	cycle.join(" "),
);
const spec = (raw) => {
	const parsed = parseViewSpec(raw);
	return parsed === null ? "null" : `${parsed.view}:${parsed.lines}`;
};
check("'full' -> full", spec("full") === "full:3");
check("'hidden' -> hidden", spec("hidden") === "hidden:3");
check("'off' -> full", spec("off") === "full:3");
check("'on' -> preview", spec("on") === "preview:3");
check("'5' -> preview 5", spec("5") === "preview:5");
check("'0' -> hidden", spec("0") === "hidden:3");
check("'999' clamps to 500", spec("999") === "preview:500");
check("'abc' is rejected", spec("abc") === "null");
check("'' is rejected", spec("") === "null");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);