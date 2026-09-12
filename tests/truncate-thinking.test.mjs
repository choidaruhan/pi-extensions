import { DIST } from "./pi-root.mjs";

const { truncateThinking, formatDuration, createThinkingTiming, createThinkingTransformer, expandHint } = await import(
  new URL("../extensions/thinking-preview.ts", import.meta.url).href
);

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const think = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n\n");

// 1) a block shorter than N keeps every line, but still reports its duration
const short = truncateThinking(think(3), 5, { durationMs: 3600 });
check("short block keeps every line", short.includes("line 1") && short.includes("line 3"));
check("short block has no hint", !short.includes("earlier line"));
check("short block still gets the footer", short.trimEnd().endsWith("Took 3.6s"));

// 2) a long block shows the tail (most recent reasoning), hint above, footer below
const long = truncateThinking(think(30), 5, { durationMs: 3600 });
const longLines = long.split("\n");
check("hint is the first line", longLines[0] === "... (25 earlier lines, ctrl+o to expand)", longLines[0]);
check("head lines are dropped", !long.includes("line 25"));
check("tail lines are kept", long.includes("line 26") && long.includes("line 30"));
check("footer is the last line", longLines[longLines.length - 1] === "Took 3.6s", longLines[longLines.length - 1]);
check("hint/body/footer separated by blank lines", /\n\nline 26/.test(long) && /\n\nTook/.test(long));
check("no blank-line pile-up", !/\n\n\n/.test(long));

// 3) singular wording, zero-line mode, footer labels
check("singular hint for one dropped line", truncateThinking(think(2), 1) === "... (1 earlier line, ctrl+o to expand)\n\nline 2");
check("blank separators do not leak into the tail", truncateThinking("l1\n\n\nl2", 1) === "... (1 earlier line, ctrl+o to expand)\n\nl2");
check("maxLines=0 returns the markdown untouched", truncateThinking(think(5), 0, { durationMs: 1000 }) === think(5));
check("streaming footer says Elapsed", truncateThinking(think(30), 1, { durationMs: 2100, isStreaming: true }).endsWith("Elapsed 2.1s"));
check("no footer without a duration", !truncateThinking(think(30), 1).includes("Took"));

// 4) an unclosed code fence in the tail is closed before the footer
const fenced = truncateThinking("```js\ncode 1\ncode 2\ncode 3\ncode 4\n```", 2, { durationMs: 900 });
check("dangling fence is closed", fenced.includes("code 4\n```\n```\n\nTook 0.9s"), JSON.stringify(fenced));

// 5) duration formatting matches pi's bash footer
check("formatDuration(3600) is 3.6s", formatDuration(3600) === "3.6s");
check("formatDuration(0) is 0.0s", formatDuration(0) === "0.0s");
check("formatDuration(65000) is 65.0s", formatDuration(65000) === "65.0s");

// 6) hint text override
process.env.PI_THINKING_PREVIEW_HINT = "press X to expand";
check("env overrides the hint", expandHint() === "press X to expand" && truncateThinking(think(3), 1).includes("press X to expand"));
delete process.env.PI_THINKING_PREVIEW_HINT;

// 7) duration tracking across streaming renders
const observe = createThinkingTiming();
check("streaming block has no duration yet", observe("hello", true, 1000) === null);
check("growing block keeps measuring", observe("hello world", true, 2000) === null);
check("final render reports the elapsed time", observe("hello world done", false, 4600) === 3600);
check("re-render keeps the measured time", observe("hello world done", false, 9000) === 3600);
observe("another block", true, 10000);
check("a previous block still resolves via the cache", observe("hello world done", false, 11000) === 3600);
check("a block never seen streaming has no timing", observe("restored from disk", false, 12000) === null);
check("that block does not clobber the active timer", observe("another block grows", true, 13000) === null);
check("the active block still measures its own span", observe("another block grows more", false, 15000) === 5000);

// 8) transformer wiring: only thinking parts are touched, isStreaming is forwarded
const lines = { value: 1 };
const transformer = createThinkingTransformer(
  () => lines.value,
  (_markdown, isStreaming) => (isStreaming ? 2100 : 3600),
);
const answer = transformer("Took nothing here, just the answer.", { messageType: "assistant-text", isStreaming: false });
check("answer text is passed through untouched", answer === "Took nothing here, just the answer.");
check("thinking parts are previewed", transformer(think(30), { messageType: "assistant-thinking", isStreaming: false }).includes("29 earlier lines"));
check(
  "streaming thinking parts show Elapsed",
  transformer(think(30), { messageType: "assistant-thinking", isStreaming: true }).endsWith("Elapsed 2.1s"),
);
lines.value = 4;
check("the transformer reads N live", transformer(think(30), { messageType: "assistant-thinking", isStreaming: false }).includes("26 earlier lines"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
