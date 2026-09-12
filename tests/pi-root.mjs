// Locates the installed pi package so the suites can import pi's dist (the real
// TUI components) across install methods and version bumps.
//
// Order: $PI_ROOT -> the `pi` on PATH -> Homebrew Cellar scan (newest first).
import { execSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function candidateRoots() {
	const roots = [];

	if (process.env.PI_ROOT) roots.push(process.env.PI_ROOT);

	try {
		const bin = realpathSync(
			execSync("command -v pi", { encoding: "utf8", shell: "/bin/bash" }).trim(),
		);
		// Homebrew: <cellar>/<version>/bin/pi
		roots.push(join(dirname(dirname(bin)), "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
		// npm -g:  <prefix>/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi
		roots.push(dirname(dirname(bin)));
	} catch {
		// `pi` is not on PATH; fall through to the Cellar scan.
	}

	const cellar = "/opt/homebrew/Cellar/pi-coding-agent";
	if (existsSync(cellar)) {
		for (const version of readdirSync(cellar).sort().reverse()) {
			roots.push(
				join(cellar, version, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
			);
		}
	}

	return roots;
}

export function findPiRoot() {
	for (const root of candidateRoots()) {
		if (existsSync(join(root, "dist", "index.js"))) return root;
	}
	throw new Error("Could not locate the installed pi package. Set PI_ROOT to its package root.");
}

export const PI_ROOT = findPiRoot();
export const DIST = join(PI_ROOT, "dist");
