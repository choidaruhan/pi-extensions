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
 * The extensions import "@earendil-works/pi-tui" and "@earendil-works/pi-coding-agent" by
 * bare specifier; pi's own loader resolves them against the copies bundled with pi. Plain
 * node needs node_modules entries, so point them at those same copies — identical code, no
 * vendoring.
 */
export function linkPiPackage(name, target) {
	if (!existsSync(join(target, "dist", "index.js"))) return null;
	const dir = join(REPO_ROOT, "node_modules", "@earendil-works");
	const link = join(dir, name);
	try {
		mkdirSync(dir, { recursive: true });
		rmSync(link, { force: true });
		symlinkSync(target, link, "dir");
	} catch (error) {
		console.log(`${name} link skipped: ${error.message}`);
		return null;
	}
	return link;
}

/** Created on import so every suite can load the extensions as-is. */
export const PI_TUI_LINK = linkPiPackage(
	"pi-tui",
	join(PI_ROOT, "node_modules", "@earendil-works", "pi-tui"),
);
export const PI_AGENT_LINK = linkPiPackage("pi-coding-agent", PI_ROOT);
