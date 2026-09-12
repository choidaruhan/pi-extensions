import { DIST } from "./pi-root.mjs";

const { createThinkingTransformer } = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
initTheme("dark", false);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

let liveN = 3; // mimics the extension's module-level previewLines
const transformers = [createThinkingTransformer(() => liveN, () => 1200)];

const thinking = Array.from({ length: 30 }, (_, i) => `step ${i + 1}: reasoning`).join("\n\n");
const msg = { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "Answer: 391" }] };
const render = (comp) => strip(comp.render(100).join("\n"));

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

// 1) each N shows a different number of earlier lines, always keeping the newest ones
const byN = {};
for (const n of [1, 3, 5]) {
  liveN = n;
  const out = render(new AssistantMessageComponent(msg, false, undefined, "Thinking...", 1, transformers));
  byN[n] = out;
  const hint = out.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint";
  console.log(`N=${n} -> ${hint}`);
  check(`N=${n} keeps the newest line`, out.includes("step 30"));
  check(`N=${n} drops the oldest lines`, !out.includes("step 1:"));
  check(`N=${n} hint counts ${30 - n} earlier lines`, hint.includes(`${30 - n} earlier lines`));
  check(`N=${n} keeps footer and answer`, out.includes("Took 1.2s") && out.includes("391"));
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
check("pre-refresh render showed 25 earlier lines", before.includes("25 earlier lines"));
check("post-refresh render showed 29 earlier lines", after.includes("29 earlier lines"));

// 3) hidden mode short-circuits transformers entirely
const hidden = render(new AssistantMessageComponent(msg, true, undefined, "Thinking...", 1, transformers));
check(
  "hideThinkingBlock=true renders only the label plus the answer",
  hidden.includes("Thinking...") && hidden.includes("Answer: 391") && !/earlier lines|step 30|Took/.test(hidden),
  JSON.stringify(hidden.split("\n").map((l) => l.trim()).filter(Boolean)),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
