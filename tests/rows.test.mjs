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
const { Markdown } = await import("@earendil-works/pi-tui");
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

const words = "product seventeen times twenty three reasoning ".repeat(12).trim();
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
	check(`width ${width}: every shape exact`, wrong.length === 0, wrong.join(", "));
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

console.log("\n── a cut line keeps the tail of its own text, not the head");
const tail = tailByRows(`step one\nstep two\n${longLine}`, 2, 40);
const flat = longLine.replace(/\s+/g, " ");
const fragment = tail.shown.replace(/\s+/g, " ").trim();
check(
	"the fragment is a suffix of the wrapped line",
	flat.endsWith(fragment) && fragment.length < flat.length && fragment.length > 0,
	JSON.stringify({ fragment, dropped: flat.length - fragment.length }),
);
check(
	"the fragment keeps the line's last word",
	fragment.endsWith(longLine.trim().split(" ").at(-1)),
	JSON.stringify(fragment),
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);