// Locates the installed pi package so the suites can import pi's dist (the real
// TUI components) across install methods and version bumps.
//
// Order: $PI_ROOT -> the `pi` on PATH -> Homebrew Cellar scan (newest first).
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function candidateRoots() {
	const roots = [];

	if (process.env.PI_ROOT) roots.push(process.env.PI_ROOT);

	try {
		const bin = realpathSync(
			execSync("command -v pi", { encoding: "utf8", shell: "/bin/bash" }).trim(),
		);
		// Homebrew: <cellar>/<version>/bin/pi
		roots.push(
			join(
				dirname(dirname(bin)),
				"libexec",
				"lib",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
			),
		);
		// npm -g:  <prefix>/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi
		roots.push(dirname(dirname(bin)));
	} catch {
		// `pi` is not on PATH; fall through to the Cellar scan.
	}

	const cellar = "/opt/homebrew/Cellar/pi-coding-agent";
	if (existsSync(cellar)) {
		for (const version of readdirSync(cellar).sort().reverse()) {
			roots.push(
				join(
					cellar,
					version,
					"libexec",
					"lib",
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
				),
			);
		}
	}

	return roots;
}

export function findPiRoot() {
	for (const root of candidateRoots()) {
		if (existsSync(join(root, "dist", "index.js"))) return root;
	}
	throw new Error(
		"Could not locate the installed pi package. Set PI_ROOT to its package root.",
	);
}

export const PI_ROOT = findPiRoot();
export const DIST = join(PI_ROOT, "dist");

/**
 * The extension imports "@earendil-works/pi-tui" by bare specifier; pi's own
 * loader resolves it against its bundled copy. Plain node needs a node_modules
 * entry, so point one at that same copy — identical code, no vendoring.
 */
export function linkPiTui() {
	const target = join(PI_ROOT, "node_modules", "@earendil-works", "pi-tui");
	if (!existsSync(join(target, "dist", "index.js"))) return null;
	const dir = join(REPO_ROOT, "node_modules", "@earendil-works");
	const link = join(dir, "pi-tui");
	try {
		mkdirSync(dir, { recursive: true });
		rmSync(link, { force: true });
		symlinkSync(target, link, "dir");
	} catch (error) {
		console.log(`pi-tui link skipped: ${error.message}`);
		return null;
	}
	return link;
}

/** Created on import so every suite can load the extension as-is. */
export const PI_TUI_LINK = linkPiTui();
