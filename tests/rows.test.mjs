/**
 * Row-aware preview tests.
 *
 * Everything here is checked against pi's own markdown renderer (the real `Markdown` class
 * from the installed dist). That is not a test-only oracle: the extension measures rows with
 * the same class, so these tests compare the shipped counter against the renderer that draws
 * it. The fallback model is covered separately, on the shapes it is expected to agree on.
 */
import { DIST } from "./pi-root.mjs";

const {
	countRenderedRows,
	measureLines,
	rowCounterSource,
	tailByRows,
	truncateThinking,
} = await import(
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

// If the renderer could not be built, every row assertion below would silently test the
// fallback model instead, so fail loudly before measuring anything.
check("rows come from pi's renderer", rowCounterSource() === "renderer");

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

console.log("\n── a paragraph continuation keeps the indent pi wraps it with");
// A lazy continuation line stays inside the paragraph above it, and pi keeps the whitespace
// that line carries instead of trimming it. That makes a line landing within `indent` columns
// of the wrap boundary one row taller than its trimmed text: the "N=5 shows 6 rows" class.
for (const width of [40, 70, 80]) {
	const wrong = [];
	for (const indent of [1, 2, 3])
		for (let len = width - indent - 1; len <= width - indent + 2; len++) {
			const md = `${words}\n${" ".repeat(indent)}${"y".repeat(len)}`;
			const real = turn(md, width);
			const model = countRenderedRows(md, width);
			if (real !== model)
				wrong.push(`indent=${indent} len=${len}: pi=${real} model=${model}`);
		}
	check(
		`width ${width}: continuation rows exact`,
		wrong.length === 0,
		wrong.join(", "),
	);
}

console.log("\n── an indented continuation preview renders the budget exactly");
// Same shape end to end: whatever the widths are, the composed preview has to come out as
// exactly the budgeted rows under the hint row that says what was hidden.
const filler = Array.from({ length: 6 }, (_, i) => `step ${i + 1}`).join("\n");
for (const width of [70, 80]) {
	const wrong = [];
	for (const indent of [1, 2, 3])
		for (let len = width - indent - 3; len <= width - indent + 3; len++) {
			const md = `${filler}\n${words}\n${" ".repeat(indent)}y${"y".repeat(len)}`;
			const budget = 5;
			// The composed preview is what pi renders: the reasoning rows, plus the hint row the tail
			// hangs under. The merge with the hint can drop the continuation's indent, so the rendering
			// is measured as a whole — never more than the budget, and exact on these shapes.
			const shown = truncateThinking(md, budget, { width });
			const rows = turn(shown, width);
			if (rows !== budget + 1)
				wrong.push(`indent=${indent} len=${len}: ${rows} != ${budget + 1}`);
		}
	check(
		`width ${width}: exactly ${5} rows + hint`,
		wrong.length === 0,
		wrong.join(", "),
	);
}

console.log("\n── shapes the fallback model disagrees on, measured by pi");
// The model above stays the fallback when a renderer cannot be built, so the shapes that
// exposed its gaps stay in the suite: inline emphasis it strips where pi renders the markers
// literally, a first line indented far enough that pi reads a code block, and a table cell
// wider than the column pi pads. The shipped counter has to be exact on all of them.
const formerDeviations = [
	"for f in $files; do [[ -n ${_comps[${f#_}]} ]] && (( matched++ )); done",
	`${" ".repeat(4)}y${"y".repeat(80)}`,
	'- `grep -rn "onTerminalInput\\|registerKeybinding" $D/dist/**/*.d.ts`',
	`| shape | rows |\n| --- | --- |\n| long cell | ${"z".repeat(60)} |`,
];
for (const width of [70, 80]) {
	const wrong = [];
	for (const md of formerDeviations)
		if (countRenderedRows(md, width) !== turn(md, width))
			wrong.push(`pi=${turn(md, width)} counter=${countRenderedRows(md, width)}`);
	check(
		`width ${width}: every former deviation exact`,
		wrong.length === 0,
		wrong.join(", "),
	);
}

console.log("\n── the fallback model still holds on plain shapes");
// Reached only when the renderer is unavailable, but still what the preview falls back to, so
// it has to keep counting the shapes it claims: prose, CJK, list and quote prefixes, fences.
const modelRows = (markdown, width) =>
	measureLines(markdown.replace(/\s+$/, "").split("\n"), width).reduce(
		(rows, line) => rows + line.rows,
		0,
	);
for (const width of [20, 40, 100]) {
	const wrong = [];
	for (const name of ["prose", "long line", "cjk", "bullet", "quote", "fence"]) {
		const md = shapes[name];
		if (modelRows(md, width) !== turn(md, width))
			wrong.push(`${name}: pi=${turn(md, width)} model=${modelRows(md, width)}`);
	}
	check(
		`width ${width}: fallback model matches pi`,
		wrong.length === 0,
		wrong.join(", "),
	);
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

console.log("\n── a block taller than the budget even on its own still shows rows");
// Shapes where the render disagrees with the line model about a single line's height: CJK costs
// two columns per character, pi reads an indented first line as a code block, and a table cell
// wider than its column is drawn across rows. The fallback used to trim the only line away and
// hand the reader an empty block; it now keeps the rows of pi's own render of that line.
for (const [name, markdown] of [
	["a CJK line", "가".repeat(60)],
	["a quoted CJK line", `> ${"가".repeat(50)}`],
	["an indented line", `${" ".repeat(4)}y${"y".repeat(120)}`],
	["a wide table cell", `| a |\n| --- |\n| ${"z".repeat(90)} |`],
]) {
	for (const width of [70, 80]) {
		for (const budget of [1, 2]) {
			const shown = truncateThinking(markdown, budget, { width });
			const rows = turn(shown, width);
			const hint = shown.includes("cycle)") ? 1 : 0;
			check(
				`${name} at width ${width} shows ${budget} row(s)`,
				shown !== "" && rows - hint === budget,
				`rows=${rows} hint=${hint} shown=${JSON.stringify(shown.slice(0, 40))}`,
			);
		}
	}
}

console.log(
	"\n── markdown in the tail that re-shapes the hint cannot buy a row",
);
// The hint and the tail are one paragraph, so markdown in the tail can re-shape the hint itself:
// a `===` / `---` underline on the line under the hint promotes the hint line to a heading and pi
// colours it, which is all it takes for the hint to stop being a literal prefix of the
// composition. An earlier version read that as "the merge re-wrapped the hint" and gave a row
// back for it, so a five-row budget rendered six rows of reasoning. A tail line that merges
// into the hint as a lazy continuation and re-flows it is the same family.
for (const [name, markdown, width] of [
	["a setext underline under the hint", "aaa\n===\naaa\n# h\naaa", 20],
	["a thematic-break-looking underline", "aaa\n---\naaa\n# h\naaa", 20],
	[
		"a lazy continuation merging into the hint",
		"    an indented line\n> quoted words here\n   more indented text\n> > nested quote\n| a | b |\n---\n# h1\n  1. a numbered item",
		40,
	],
]) {
	const budget = 5;
	const shown = truncateThinking(markdown, budget, { width });
	// The hint wraps when the preview is narrow, so its own rows are measured at the same width and
	// taken off the composition's rows: what is left is what the reader counts as reasoning.
	const hint = shown === "" ? "" : shown.split("\n")[0];
	const rows = shown === "" ? 0 : turn(shown, width) - turn(hint, width);
	check(
		`${name} at width ${width}: at most ${budget} reasoning rows`,
		shown !== "" && rows <= budget,
		`rows=${rows}`,
	);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
