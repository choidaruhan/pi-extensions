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

let live = { view: "preview", lines: 3 }; // mimics the extension's module-level state
const transformers = [
	createThinkingTransformer(
		() => live,
		() => 1200,
	),
];

const thinking = Array.from(
	{ length: 30 },
	(_, i) => `step ${i + 1}: reasoning`,
).join("\n\n");
const msg = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking },
		{ type: "text", text: "Answer: 391" },
	],
};
const render = (comp) => strip(comp.render(100).join("\n"));
const make = (hidden = false) =>
	new AssistantMessageComponent(
		msg,
		hidden,
		undefined,
		"Thinking...",
		1,
		transformers,
	);

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

// 1) each N shows a different number of earlier lines, always keeping the newest ones
const byN = {};
for (const n of [1, 3, 5]) {
	live = { view: "preview", lines: n };
	const out = render(make());
	byN[n] = out;
	const hint = out.match(/\.\.\. \([^)]*\)/)?.[0] ?? "no hint";
	console.log(`N=${n} -> ${hint}`);
	check(`N=${n} keeps the newest line`, out.includes("step 30"));
	check(`N=${n} drops the oldest lines`, !out.includes("step 1:"));
	check(
		`N=${n} hint counts ${30 - n} earlier lines`,
		hint.includes(`${30 - n} earlier lines`),
	);
	check(
		`N=${n} keeps footer and answer`,
		out.includes("Took 1.2s") && out.includes("391"),
	);
}
check(
	"N=1, N=3, N=5 render differently",
	new Set([byN[1], byN[3], byN[5]]).size === 3,
);
check(
	"N=1 render is shorter than N=5",
	byN[1].split("\n").length < byN[5].split("\n").length,
);

// 2) the three levels are ordered by how much they show
const size = {};
for (const view of ["full", "preview", "hidden"]) {
	live = { view, lines: 3 };
	size[view] = render(make()).split("\n").length;
}
console.log(
	`lines rendered: full=${size.full} preview=${size.preview} hidden=${size.hidden}`,
);
check(
	"full > preview > hidden",
	size.full > size.preview && size.preview > size.hidden,
	`${size.full} > ${size.preview} > ${size.hidden}`,
);

// 3) changing the level must update an ALREADY rendered component once the transcript is refreshed
live = { view: "preview", lines: 5 };
const comp = make();
const before = render(comp);
live = { view: "hidden", lines: 5 };
check("stale render is unchanged before refresh", render(comp) === before);
comp.setHiddenThinkingLabel("Thinking..."); // what ui.setHiddenThinkingLabel() triggers per component
const after = render(comp);
check(
	"refresh (setHiddenThinkingLabel) re-renders with the new level",
	after !== before,
);
check(
	"pre-refresh render showed the preview",
	before.includes("25 earlier lines"),
);
check(
	"post-refresh render hides the reasoning",
	!after.includes("step 30") &&
		after.includes("Thinking...") &&
		after.includes("391"),
);
live = { view: "full", lines: 5 };
comp.setHiddenThinkingLabel("Thinking...");
const back = render(comp);
check(
	"switching back to full restores every step",
	back.includes("step 1:") &&
		back.includes("step 30") &&
		!back.includes("earlier line"),
);

// 4) pi's own hidden mode short-circuits transformers entirely
live = { view: "preview", lines: 3 };
const builtinHidden = render(make(true));
check(
	"hideThinkingBlock=true renders only the label plus the answer",
	builtinHidden.includes("Thinking...") &&
		builtinHidden.includes("Answer: 391") &&
		!/earlier lines|step 30|Took/.test(builtinHidden),
	JSON.stringify(
		builtinHidden
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
