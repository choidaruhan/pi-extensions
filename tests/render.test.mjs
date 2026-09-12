import { DIST } from "./pi-root.mjs";

const { createThinkingTransformer } = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
initTheme("dark", false);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const thinking = Array.from({ length: 30 }, (_, i) => `step ${i + 1}: deep reasoning about the product 17x23`).join("\n\n");
const msg = { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "Answer: 391" }] };

// The extension's real transformer, used exactly as registerMarkdownTransformer uses it:
// pi wraps it per markdown part, so it sees the answer text too and must ignore it.
const transformer = createThinkingTransformer(() => 5, () => 3600);
const render = (transformers) =>
  strip(new AssistantMessageComponent(msg, false, undefined, "Thinking...", 1, transformers).render(100).join("\n"));
const rows = (t) => t.split("\n").filter((l) => l.trim()).length;

let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const plain = render([]);
const preview = render([transformer]);

console.log(`plain: ${rows(plain)} rendered lines | preview: ${rows(preview)} rendered lines`);
check("plain render shows the last reasoning step", plain.includes("step 30"));
check("preview keeps the tail (step 26-30)", preview.includes("step 26") && preview.includes("step 30"));
check("preview drops the head", !preview.includes("step 1:"));
check(
  "preview shows the collapsed-style hint",
  preview.includes("... (25 earlier lines, ctrl+o to expand)"),
  preview.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint",
);

const hintAt = preview.indexOf("... (25 earlier lines");
const tailAt = preview.indexOf("step 26");
const answerAt = preview.indexOf("Answer: 391");
const footerAt = preview.indexOf("Took 3.6s");
check("hint sits above the tail", hintAt !== -1 && hintAt < tailAt);
check(
  "Took footer lands between the tail and the answer",
  footerAt > tailAt && footerAt < answerAt,
  `hint@${hintAt} tail@${tailAt} footer@${footerAt} answer@${answerAt}`,
);
check("the answer text gets no footer of its own", preview.indexOf("Took", footerAt + 1) === -1);
check("answer still visible in preview", preview.includes("391"));
check("preview is shorter than plain", rows(preview) < rows(plain), `${rows(preview)} < ${rows(plain)}`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
