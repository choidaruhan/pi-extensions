// N persistence: built-in default, saved round-trip, and env precedence.
//
// Isolation: the extension derives its state path from $HOME at module load, so
// $HOME is redirected to a temp dir BEFORE the import. The real
// ~/.pi/agent/thinking-preview.json is never touched.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = process.env.TP_TEST_HOME ?? join(tmpdir(), "pi-extensions-state-test");

const mode = process.argv[2];
let fail = 0;
const check = (name, cond, extra = "") => {
	if (!cond) fail++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const statePath = join(process.env.HOME, ".pi", "agent", "thinking-preview.json");
if (mode === "write") {
	rmSync(statePath, { force: true });
	delete process.env.PI_THINKING_PREVIEW_LINES;
}

const { initialPreviewLines, loadSavedPreviewLines, savePreviewLines } = await import(
	new URL("../extensions/thinking-preview.ts", import.meta.url).href
);

if (mode === "write") {
	check("no state file + no env -> built-in default", initialPreviewLines() === 3, `N=${initialPreviewLines()}`);
	savePreviewLines(7);
	check("saved N round-trips", loadSavedPreviewLines() === 7, `read ${loadSavedPreviewLines()}`);
} else if (process.env.PI_THINKING_PREVIEW_LINES) {
	check("env beats the saved state", initialPreviewLines() === 9, `N=${initialPreviewLines()}`);
} else {
	check("saved state beats the built-in default", initialPreviewLines() === 7, `N=${initialPreviewLines()}`);
}

console.log(fail === 0 ? "ALL PASS" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
