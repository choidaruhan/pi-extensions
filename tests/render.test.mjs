import { DIST } from "./pi-root.mjs";

const { truncateThinking } = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);
const { AssistantMessageComponent, initTheme } = await import(`${DIST}/index.js`);
const { createMarkdownTransform } = await import(`${DIST}/modes/interactive/components/markdown-transform.js`);
initTheme("dark", false);

const thinking = Array.from({ length: 30 }, (_, i) => `step ${i + 1}: deep reasoning about the product 17x23`).join("\n\n");
const msg = { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: "Answer: 391" }] };

const render = (transformers) =>
  new AssistantMessageComponent(msg, false, undefined, "Thinking...", 1, transformers).render(100).join("\n");

const plain = render([]);
const preview = render([createMarkdownTransform("assistant-thinking", false, [(md) => truncateThinking(md, 5)])]);

const rows = (t) => t.split("\n").filter((l) => l.trim()).length;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

console.log(`plain:   ${rows(plain)} rendered lines | preview: ${rows(preview)} rendered lines`);
check("plain render shows last reasoning step", plain.includes("step 30"));
check("preview render drops the tail", !preview.includes("step 30") && !preview.includes("step 6"));
check("preview render keeps the head", preview.includes("step 1") && preview.includes("step 5"));
check("preview render shows the counter hint", /more lines, 30 total/.test(preview), preview.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint");
check("answer still visible in preview", preview.includes("391"));
check("preview is shorter", rows(preview) < rows(plain), `${rows(preview)} < ${rows(plain)}`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
