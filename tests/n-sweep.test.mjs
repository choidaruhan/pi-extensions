import { DIST } from "./pi-root.mjs";

const { truncateThinking } = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
const { createMarkdownTransform } = await import(`${DIST}/modes/interactive/components/markdown-transform.js`);
initTheme("dark", false);

let liveN = 3; // mimics the extension's module-level previewLines
const transformer = (md, ctx) => (ctx.messageType === "assistant-thinking" ? truncateThinking(md, liveN) : md);
const transformers = [createMarkdownTransform("assistant-thinking", false, [transformer])];

const thinking = Array.from({ length: 30 }, (_, i) => `step ${i + 1}: reasoning`).join("\n\n");
const msg = { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "Answer: 391" }] };
const render = (comp) => comp.render(100).join("\n");

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

// 1) each N must produce a different hint counter
const byN = {};
for (const n of [1, 3, 5]) {
  liveN = n;
  const out = render(new AssistantMessageComponent(msg, false, undefined, "Thinking...", 1, transformers));
  byN[n] = out;
  const hint = out.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint";
  console.log(`N=${n} -> ${hint}`);
  check(`N=${n} keeps head line 1 and drops the tail`, out.includes("step 1") && !out.includes("step 30"));
  check(`N=${n} shows ${30 - n} remaining`, hint.includes(`${30 - n} more lines`));
  check(`N=${n} keeps the answer text`, out.includes("391"));
}
check("N=1, N=3, N=5 render differently", new Set([byN[1], byN[3], byN[5]]).size === 3);
check("N=1 render is shorter than N=5", byN[1].split("\n").length < byN[5].split("\n").length);

// 2) changing N must update an ALREADY rendered component once the transcript is refreshed
liveN = 5;
const comp = new AssistantMessageComponent(msg, false, undefined, "Thinking...", 1, transformers);
const before = render(comp);
liveN = 1;
check("stale render is unchanged before refresh", render(comp) === before);
comp.setHiddenThinkingLabel("Thinking..."); // what ui.setHiddenThinkingLabel() triggers per component
const after = render(comp);
check("refresh (setHiddenThinkingLabel) re-renders with the new N", after !== before);
check("post-refresh render shows 29 more lines", /29 more lines/.test(after));
check("pre-refresh render showed 25 more lines", /25 more lines/.test(before));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();

// 3) hidden mode short-circuits transformers even with a live N=1
const hidden = render(new AssistantMessageComponent(msg, true, undefined, "Thinking...", 1, transformers));
check(
  "hideThinkingBlock=true renders only the label",
  strip(hidden).includes("Thinking...") && !/more lines|step 1/.test(hidden),
  JSON.stringify(strip(hidden).split("\n").map((l) => l.trim()).filter(Boolean)),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
