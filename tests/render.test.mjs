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
const transformer = createThinkingTransformer(() => state);
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
	"preview keeps the newest reasoning (step 26-30)",
	preview.includes("step 26") && preview.includes("step 30"),
);
check("preview drops the head", !preview.includes("step 25"));
check(
	"preview shows the collapsed-style hint",
	preview.includes("... (25 earlier lines, ctrl+t to cycle)"),
	preview.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint",
);

const hintAt = preview.indexOf("... (25 earlier lines");
const tailAt = preview.indexOf("step 26");
const answerAt = preview.indexOf("Answer: 391");
check("hint sits above the tail", hintAt !== -1 && hintAt < tailAt);
// The block is exactly N rows tall and every row is text: the hint sits directly above the
// first kept line, with no blank separator spending one of the N rows on spacing.
const previewLines = preview.split("\n").map((line) => line.trim());
const hintLine = previewLines.findIndex((line) =>
	line.startsWith("... (25 earlier"),
);
const tailLine = previewLines.findIndex((line) => line.startsWith("step 26:"));
check(
	"hint sits directly above the tail, no blank row between",
	tailLine === hintLine + 1,
	`hint@${hintLine} tail@${tailLine}`,
);
check(
	"the preview block is the hint plus exactly 5 rows of text",
	hintLine !== -1 &&
		previewLines.slice(hintLine, hintLine + 6).every((line) => line !== "") &&
		previewLines[hintLine + 6] === "",
	JSON.stringify(previewLines.slice(hintLine, hintLine + 7)),
);
check(
	"the tail sits above the answer",
	tailAt !== -1 && tailAt < answerAt,
	`hint@${hintAt} tail@${tailAt} answer@${answerAt}`,
);
check("the block gets no duration footer", !preview.includes("Took"));
check("answer still visible in preview", preview.includes("391"));
check(
	"preview is shorter than plain",
	rows(preview) < rows(plain),
	`${rows(preview)} < ${rows(plain)}`,
);

// Level 1: the whole block renders.
state.view = "full";
const full = render([transformer]);
check(
	"full level keeps the first and last reasoning step",
	full.includes("step 1:") && full.includes("step 30"),
);
check("full level has no hint", !full.includes("earlier line"));
check("full level gets no footer", !full.includes("Took"));
check(
	"full level is taller than preview",
	rows(full) > rows(preview),
	`${rows(full)} > ${rows(preview)}`,
);
check(
	"full level lands the answer after the reasoning",
	full.indexOf("step 30") < full.indexOf("Answer: 391"),
);

// Level 3: one muted label, no reasoning text.
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

// N is the number of reasoning rows on screen; the hint row sits on top of it and is not
// charged to the budget. This is the bug the row budget exists to fix — the preview used
// to grow well past N rows as the tail took on more blank separators.
const prose = Array.from(
	{ length: 20 },
	(_, i) => `step ${i + 1}: plain reasoning line`,
).join("\n\n");
const height = (lines) => {
	state.view = "preview";
	state.lines = lines;
	const out = strip(
		new AssistantMessageComponent(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: prose },
					{ type: "text", text: "Answer: 391" },
				],
			},
			false,
			undefined,
			"Thinking...",
			1,
			[transformer],
		)
			.render(100)
			.join("\n"),
	).split("\n");
	// The component pads one row above the block and one row before the answer.
	return out.findIndex((line) => line.includes("Answer")) - 2;
};
for (const n of [3, 5, 7, 9]) {
	const shown = height(n);
	check(
		`preview of ${n} rows renders ${n} reasoning rows plus the hint`,
		shown === n + 1,
		`${shown}`,
	);
}

// Exactness across shapes and widths: N rows of reasoning, with the hint (it wraps on a
// narrow preview) sitting above them for free.
const shapeOf = {
	short: Array.from({ length: 30 }, (_, i) => `step ${i + 1}: reasoning`).join(
		"\n\n",
	),
	long: Array.from(
		{ length: 30 },
		(_, i) => `step ${i + 1}: ${"deep reasoning word ".repeat(6)}`,
	).join("\n\n"),
	fenced: `${Array.from({ length: 10 }, (_, i) => `step ${i + 1}: reasoning`).join("\n\n")}\n\n\`\`\`js\n${"const x = 1; // code line\n".repeat(8)}\`\`\``,
	list: Array.from(
		{ length: 20 },
		(_, i) => `- item ${i + 1}: ${"detail ".repeat(4)}`,
	).join("\n\n"),
	quote: Array.from(
		{ length: 20 },
		(_, i) => `> quoted step ${i + 1} ${"words ".repeat(3)}`,
	).join("\n\n"),
};
const blockRows = (thinking, lines, width) => {
	state.view = "preview";
	state.lines = lines;
	const out = strip(
		new AssistantMessageComponent(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text: "Answer: 391" },
				],
			},
			false,
			undefined,
			"Thinking...",
			1,
			[transformer],
		)
			.render(width)
			.join("\n"),
	).split("\n");
	const answerAt = out.findIndex((line) => line.includes("Answer"));
	// Every row between the pad and the blank separator in front of the answer belongs to the
	// block, including the empty row pi renders in front of a blockquote.
	return out.slice(1, answerAt - 1);
};
// The hint is not charged to the budget, so the block is N rows of reasoning plus however
// many rows the hint itself occupies (it wraps on a narrow preview).
const hintRowCount = (rendered) => {
	const last = rendered.findIndex((line) => line.includes("cycle)"));
	return last >= 0 ? last + 1 : 0;
};
for (const [shape, text] of Object.entries(shapeOf)) {
	for (const width of [100, 60, 34, 20]) {
		const wrong = [];
		for (let n = 1; n <= 12; n++) {
			const rendered = blockRows(text, n, width);
			const hint = hintRowCount(rendered);
			// A block that fits the budget is shown whole, so it may be shorter than N.
			if (hint === 0 ? rendered.length > n : rendered.length !== n + hint)
				wrong.push(`N=${n}->${rendered.length}, hint ${hint}`);
		}
		check(
			`${shape} at width ${width}: every budget renders exactly N reasoning rows plus the hint`,
			wrong.length === 0,
			wrong.join(" "),
		);
	}
}

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
check(
	"stale render is unchanged before refresh",
	strip(live.render(100).join("\n")) === before,
);
live.setHiddenThinkingLabel("Thinking..."); // what ui.setHiddenThinkingLabel() triggers per component
const after = strip(live.render(100).join("\n"));
check(
	"refresh re-renders after a level change",
	after !== before && !after.includes("step 30"),
);

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
