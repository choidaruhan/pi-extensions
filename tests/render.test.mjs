import { DIST } from "./pi-root.mjs";

const { createThinkingTransformer } = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);
const { AssistantMessageComponent, initTheme } = await import(
	`${DIST}/index.js`
);
initTheme("dark", false);

const strip = (s) =>
	s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const thinking = Array.from(
	{ length: 30 },
	(_, i) => `step ${i + 1}: deep reasoning about the product 17x23`,
).join("\n\n");
const msg = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking },
		{ type: "text", text: "Answer: 391" },
	],
};

// The extension's real transformer, used exactly as registerMarkdownTransformer uses it:
// pi wraps it per markdown part, so it sees the answer text too and must ignore it.
const state = { view: "preview", lines: 5 };
const transformer = createThinkingTransformer(
	() => state,
	() => 3600,
);
const render = (transformers, hiddenThinkingBlock = false) =>
	strip(
		new AssistantMessageComponent(
			msg,
			hiddenThinkingBlock,
			undefined,
			"Thinking...",
			1,
			transformers,
		)
			.render(100)
			.join("\n"),
	);
const rows = (t) => t.split("\n").filter((l) => l.trim()).length;

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

const plain = render([]);
const preview = render([transformer]);

console.log(
	`plain: ${rows(plain)} rendered lines | preview: ${rows(preview)} rendered lines`,
);
check("plain render shows the last reasoning step", plain.includes("step 30"));
check(
	"preview keeps the tail (step 26-30)",
	preview.includes("step 26") && preview.includes("step 30"),
);
check("preview drops the head", !preview.includes("step 1:"));
check(
	"preview shows the collapsed-style hint",
	preview.includes("... (25 earlier lines, ctrl+t to cycle)"),
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
check(
	"the answer text gets no footer of its own",
	preview.indexOf("Took", footerAt + 1) === -1,
);
check("answer still visible in preview", preview.includes("391"));
check(
	"preview is shorter than plain",
	rows(preview) < rows(plain),
	`${rows(preview)} < ${rows(plain)}`,
);

// Level 1: the whole block renders, still with its duration footer.
state.view = "full";
const full = render([transformer]);
check(
	"full level keeps the first and last reasoning step",
	full.includes("step 1:") && full.includes("step 30"),
);
check("full level has no hint", !full.includes("earlier line"));
check("full level keeps the footer", full.includes("Took 3.6s"));
check(
	"full level is taller than preview",
	rows(full) > rows(preview),
	`${rows(full)} > ${rows(preview)}`,
);
check(
	"full level with the footer lands the answer after it",
	full.indexOf("Took 3.6s") < full.indexOf("Answer: 391"),
);

// Level 3: one muted label, no reasoning text, no footer.
state.view = "hidden";
const hidden = render([transformer]);
check(
	"hidden level shows only the label plus the answer",
	hidden.includes("Thinking...") &&
		hidden.includes("Answer: 391") &&
		!/earlier lines|step 30|Took/.test(hidden),
	JSON.stringify(
		hidden
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	),
);
check(
	"hidden level is shorter than preview",
	rows(hidden) < rows(preview),
	`${rows(hidden)} < ${rows(preview)}`,
);

// Live switching: the component caches its render, so the extension's refresh
// (ui.setHiddenThinkingLabel() -> component.setHiddenThinkingLabel()) is what makes
// a level change visible without a new message.
state.view = "preview";
const live = new AssistantMessageComponent(
	msg,
	false,
	undefined,
	"Thinking...",
	1,
	[transformer],
);
const before = strip(live.render(100).join("\n"));
state.view = "hidden";
check("stale render is unchanged before refresh", strip(live.render(100).join("\n")) === before);
live.setHiddenThinkingLabel("Thinking..."); // what ui.setHiddenThinkingLabel() triggers per component
const after = strip(live.render(100).join("\n"));
check("refresh re-renders after a level change", after !== before && !after.includes("step 30"));

// The built-in hiding still short-circuits transformers entirely.
const builtinHidden = render([transformer], true);
check(
	"pi's own hideThinkingBlock short-circuits the transformer",
	builtinHidden.includes("Thinking...") &&
		builtinHidden.includes("Answer: 391") &&
		!/earlier lines|step 30|Took/.test(builtinHidden),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);