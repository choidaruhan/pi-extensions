// Level persistence: built-in default, saved round-trip, env precedence, and
// back-compat with state files written by the pre-level version.
//
// The side-effect import links pi's bundled @earendil-works/pi-tui (the extension
// imports it by bare specifier).
//
// Isolation: the extension derives its state path from $HOME at module load, so
// $HOME is redirected to a temp dir BEFORE the import. The real
// ~/.pi/agent/thinking-preview.json is never touched.
import "./pi-root.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME =
	process.env.TP_TEST_HOME ?? join(tmpdir(), "pi-extensions-state-test");

const mode = process.argv[2];
let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`,
	);
};

const dir = join(process.env.HOME, ".pi", "agent");
const statePath = join(dir, "thinking-preview.json");
mkdirSync(dir, { recursive: true });

const { loadSavedState, saveState, resolveInitialState } = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);
const show = (state) => `${state.view}:${state.lines}`;
/** resolveInitialState reads process.env, so the cases below drive it explicitly. */
const initial = (env = {}) => show(resolveInitialState(env));

if (mode === "write") {
	rmSync(statePath, { force: true });
	check("no state file -> built-in default", initial() === "preview:5");
	check("no state file -> loadSavedState is null", loadSavedState() === null);
	check(
		"env view wins over the default",
		initial({ PI_THINKING_PREVIEW_VIEW: "full" }) === "full:5",
	);
	check(
		"env lines wins over the default",
		initial({ PI_THINKING_PREVIEW_LINES: "9" }) === "preview:9",
	);
	check(
		"env lines=0 means hidden",
		initial({ PI_THINKING_PREVIEW_LINES: "0" }) === "hidden:5",
	);
	check(
		"junk env is ignored",
		initial({ PI_THINKING_PREVIEW_VIEW: "nope" }) === "preview:5",
	);

	saveState({ view: "hidden", lines: 7 });
	check("saved state round-trips", show(loadSavedState()) === "hidden:7");
	check("saved state beats the default", initial() === "hidden:7", initial());
	check(
		"env beats the saved state",
		initial({ PI_THINKING_PREVIEW_LINES: "2" }) === "preview:2",
		initial({ PI_THINKING_PREVIEW_LINES: "2" }),
	);
	check(
		"env view keeps the saved line count",
		initial({ PI_THINKING_PREVIEW_VIEW: "full" }) === "full:7",
	);

	// Legacy files: {"previewLines": N} came from the pre-level version, where 0 meant
	// "no truncation" (the old /thinking-preview off) — that is the full level now.
	writeFileSync(statePath, `${JSON.stringify({ previewLines: 5 })}\n`, "utf8");
	check(
		"legacy previewLines -> preview",
		show(loadSavedState()) === "preview:5",
	);
	writeFileSync(statePath, `${JSON.stringify({ previewLines: 0 })}\n`, "utf8");
	check("legacy previewLines 0 -> full", show(loadSavedState()) === "full:5");
	writeFileSync(statePath, "{ not json", "utf8");
	check("corrupt state file falls back", loadSavedState() === null);

	// Leave a known state behind for the fresh-process steps below.
	saveState({ view: "hidden", lines: 7 });
	check(
		"re-saved state for the next steps",
		show(loadSavedState()) === "hidden:7",
	);
} else if (mode === "env") {
	// Fresh process: resolveInitialState() reads the real process.env here.
	const env = process.env.PI_THINKING_PREVIEW_VIEW
		? "full:7"
		: process.env.PI_THINKING_PREVIEW_LINES
			? "preview:2"
			: null;
	check(
		env === null
			? "env mode needs PI_THINKING_PREVIEW_*"
			: `env override in a fresh process (${env})`,
		env !== null && show(resolveInitialState()) === env,
		show(resolveInitialState()),
	);
} else {
	check(
		"state file survives a fresh process",
		show(loadSavedState()) === "hidden:7",
	);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
