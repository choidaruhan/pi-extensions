// Side-effect import: links pi's bundled @earendil-works/pi-tui into
// node_modules so the extension's bare specifier resolves under plain node.
import "./pi-root.mjs";

const {
	truncateThinking,
	createThinkingTransformer,
	expandHint,
	hiddenLabel,
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

// 1) a block shorter than N keeps every line, byte for byte
const short = truncateThinking(think(3), 5);
check(
	"short block keeps every line",
	short.includes("line 1") && short.includes("line 3"),
);
check("short block has no hint", !short.includes("earlier line"));
check("short block is byte-identical", short === think(3));

// 2) a long block shows the tail (most recent reasoning) with the hint above
// N is how many rows of reasoning the reader gets; the hint sits on top of them and is not
// charged to the budget. N=5 therefore shows five reasoning lines plus the hint, and no blank
// rows: every row the block occupies is a row of text the reader asked for.
const long = truncateThinking(think(30), 5);
const longLines = long.split("\n");
check(
	"hint is the first line",
	longLines[0] === `... (25 earlier lines, ${HINT})`,
	longLines[0],
);
check("head lines are dropped", !long.includes("line 25"));
check(
	"tail lines are kept",
	long.includes("line 26") && long.includes("line 30"),
);
check(
	"the tail is the last line",
	longLines[longLines.length - 1] === "line 30",
	longLines[longLines.length - 1],
);
check(
	"the block is the hint and exactly 5 rows of text",
	longLines.length === 6 &&
		longLines.slice(1).every((line) => line.trim() !== ""),
	JSON.stringify(longLines),
);
check(
	"the tail starts on the row under the hint",
	longLines[1] === "line 26" &&
		longLines.filter((line) => line.trim() === "").length === 0,
	JSON.stringify(longLines),
);

// 3) singular wording, blank-run trimming, and the fit short-circuit
check(
	"singular hint for one dropped line",
	truncateThinking("l1\n\nl2\n\nl3", 2) ===
		`... (1 earlier line, ${HINT})\nl2\nl3`,
);
check(
	"blank separators never enter the tail",
	truncateThinking("l1\n\n\n\n\nl2", 1) === `... (1 earlier line, ${HINT})\nl2`,
);
check(
	"a block as tall as the budget is left whole",
	truncateThinking(think(3), 5) === think(3),
);
check(
	"maxLines=0 returns the markdown untouched",
	truncateThinking(think(5), 0) === think(5),
);

// 4) fence markers never enter the tail, so a preview cannot end on a dangling fence
const fenced = truncateThinking(
	`${think(20)}\n\n\`\`\`js\ncode 1\ncode 2\ncode 3\ncode 4`,
	7,
);
check(
	"fence markers are dropped with the tail",
	!/`{3}/.test(fenced) && fenced.endsWith("code 4"),
	JSON.stringify(fenced),
);
check(
	"a fenced tail keeps exactly 7 reasoning rows",
	// the hint row, then the seven rows of the fence's text with no blank row between them
	fenced.split("\n").length === 8 && !fenced.includes("\n\n"),
	JSON.stringify(fenced.split("\n")),
);

// 5) hint/label text overrides
process.env.PI_THINKING_PREVIEW_HINT = "press X to expand";
check(
	"env overrides the hint",
	expandHint() === "press X to expand" &&
		truncateThinking(think(30), 3).includes("press X to expand"),
);
delete process.env.PI_THINKING_PREVIEW_HINT;
process.env.PI_THINKING_HIDDEN_LABEL = "*thinking*";
check("env overrides the hidden label", hiddenLabel() === "*thinking*");
delete process.env.PI_THINKING_HIDDEN_LABEL;
check("default hidden label matches pi's", hiddenLabel() === "Thinking...");

// 6) transformer wiring: only thinking parts are touched, live state is read
const state = { value: { view: "preview", lines: 3 } };
const transformer = createThinkingTransformer(() => state.value);
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
	}).includes("27 earlier lines"),
);
check(
	"streaming and finished thinking parts render alike",
	transformer(think(30), {
		messageType: "assistant-thinking",
		isStreaming: true,
	}) ===
		transformer(think(30), {
			messageType: "assistant-thinking",
			isStreaming: false,
		}),
);
state.value = { view: "preview", lines: 5 };
const five = transformer(think(30), {
	messageType: "assistant-thinking",
	isStreaming: false,
});
check(
	"the transformer reads the line count live",
	five.includes("25 earlier lines") && five.includes("line 26"),
);
state.value = { view: "preview", lines: 7 };
const seven = transformer(think(30), {
	messageType: "assistant-thinking",
	isStreaming: false,
});
check(
	"a larger budget keeps more reasoning",
	seven.includes("23 earlier lines") && seven.includes("line 24"),
);

// 8) the three display levels
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
check("full view is byte-identical to the markdown", full === think(30));
check("full view does not stack blank lines", !/\n\n\n/.test(full));

// 9) the thinking gate accepts both context shapes pi has used
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

// 10) view specs (flag, env and command share this parser)
check(
	"level order is full -> preview -> hidden",
	THINKING_VIEWS.join(",") === "full,preview,hidden",
);
check(
	"default state is the 5-row preview",
	DEFAULT_STATE.view === "preview" && DEFAULT_STATE.lines === 5,
);
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
check("'full' -> full", spec("full") === "full:5");
check("'hidden' -> hidden", spec("hidden") === "hidden:5");
check("'off' -> full", spec("off") === "full:5");
check("'on' -> preview", spec("on") === "preview:5");
check("'5' -> preview 5", spec("5") === "preview:5");
check("'0' -> hidden", spec("0") === "hidden:5");
check("'999' clamps to 500", spec("999") === "preview:500");
check("'abc' is rejected", spec("abc") === "null");
check("'' is rejected", spec("") === "null");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
