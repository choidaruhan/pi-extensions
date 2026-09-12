/**
 * Row-aware preview tests.
 *
 * Everything here is checked against pi's own markdown renderer (the real `Markdown` class
 * from the installed dist), not against the extension's model of it: the model is only
 * allowed to disagree where a shape is documented below as a known deviation.
 */
import { DIST } from "./pi-root.mjs";

const { countRenderedRows, tailByRows } = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);
const { initTheme } = await import(`${DIST}/index.js`);
const { getMarkdownTheme } = await import(
	`${DIST}/modes/interactive/theme/theme.js`
);
const { Markdown, wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
initTheme("dark", false);

const theme = getMarkdownTheme();
const turn = (markdown, width) =>
	new Markdown(markdown, 0, 0, theme, undefined, {}).render(width).length;

let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

const words = "product seventeen times twenty three reasoning "
	.repeat(12)
	.trim();
/** The user's report: one logical line, many rendered rows. */
const longLine = "가나다라마바사아자차카타파하 ".repeat(6).trim();

const shapes = {
	prose: words,
	"long line": longLine,
	cjk: "가나다라마바사".repeat(40),
	bullet: `- ${words}`,
	quote: `> ${words}`,
	"list in quote": `> - ${words}`,
	"nested list": `- outer\n  - ${words}`,
	"multi-line para": "ab\ncd\nef",
	fence: "```\n" + "x".repeat(400) + "\n```",
};

console.log("── whole-block row counts match pi");
for (const width of [20, 40, 100]) {
	const wrong = [];
	for (const [name, md] of Object.entries(shapes)) {
		const real = turn(md, width);
		const model = countRenderedRows(md, width);
		if (real !== model) wrong.push(`${name}: pi=${real} model=${model}`);
	}
	check(
		`width ${width}: every shape exact`,
		wrong.length === 0,
		wrong.join(", "),
	);
}

console.log("\n── a preview tail never renders more rows than asked");
for (const width of [20, 40, 100]) {
	for (const n of [1, 2, 3, 5]) {
		const wrong = [];
		for (const [name, md] of Object.entries(shapes)) {
			const { shown, hiddenRows } = tailByRows(md, n, width);
			const rows = turn(shown, width);
			const whole = hiddenRows === 0 && rows === turn(md, width);
			if (rows > n && !whole) wrong.push(`${name}: ${rows} rows`);
		}
		check(
			`width ${width} n=${n}: tail within budget`,
			wrong.length === 0,
			wrong.join(", "),
		);
	}
}

console.log("\n── the reported bug: one long line, one row asked for");
for (const width of [20, 40, 100]) {
	const { shown, hiddenRows } = tailByRows(longLine, 1, width);
	const rows = turn(shown, width);
	check(
		`width ${width}: long line preview renders 1 row`,
		rows === 1 && hiddenRows > 0,
		`rows=${rows} hidden=${hiddenRows}`,
	);
}

console.log("\n── a cut line keeps the rows the budget paid for");
const cut = tailByRows(`step one\nstep two\n${longLine}`, 2, 40);
const cutLines = cut.shown.split("\n");
check(
	"the cut preview renders exactly the budgeted rows",
	turn(cut.shown, 40) === 2,
	`rows=${turn(cut.shown, 40)}`,
);
// A cut line is re-emitted as one source line per row it kept, so each kept row has to equal
// the row pi itself would have wrapped that line into.
check(
	"the fragment is the tail rows of the wrapped line",
	JSON.stringify(cutLines) ===
		JSON.stringify(wrapTextWithAnsi(longLine, 40).slice(-cutLines.length)),
	JSON.stringify(cutLines),
);
const lastWord = longLine.trim().split(" ").at(-1);
check(
	"the fragment keeps the end of the line's last word",
	lastWord.endsWith(cutLines.at(-1).trim()),
	JSON.stringify(cutLines.at(-1)),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
