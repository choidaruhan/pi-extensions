// Keeps web-search.json `summaryModel` pointed at the active Pi model.
//
// Opt-in: does nothing unless web-search.json contains `"summaryModelAuto": true`.
// To go back to a fixed summary model, delete that key (or this file).
//
// Why this exists: pi-web-access has no "use current model" sentinel for
// `summaryModel`; it only accepts a literal `provider/model-id`, and otherwise
// falls back to its hardcoded PREFERRED_SUMMARY_MODELS list (which resolves to
// google/gemini-3.6-flash through the OpenRouter router registration).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTO_KEY = "summaryModelAuto";

// Mirrors getWebSearchConfigDir() in pi-web-access/utils.ts.
function configPath(): string {
	const explicitDir = process.env.PI_CODING_AGENT_DIR;
	if (explicitDir) return join(explicitDir, "web-search.json");

	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome) {
		const xdgDir = join(xdgConfigHome, "pi");
		if (existsSync(join(xdgDir, "web-search.json"))) return join(xdgDir, "web-search.json");
		const legacyDir = join(homedir(), ".pi", "web-search.json");
		if (existsSync(legacyDir)) return legacyDir;
		return join(xdgDir, "web-search.json");
	}
	return join(homedir(), ".pi", "agent", "web-search.json");
}

function readConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		// Never rewrite a file we cannot parse — leave it for the user.
		return {};
	}
}

function syncToModel(model: { provider?: unknown; id?: unknown } | undefined): void {
	try {
		const provider = typeof model?.provider === "string" ? model.provider : "";
		const id = typeof model?.id === "string" ? model.id : "";
		if (!provider || !id) return;

		const path = configPath();
		const config = readConfig(path);
		if (config[AUTO_KEY] !== true) return;

		const value = `${provider}/${id}`;
		if (config.summaryModel === value) return;

		config.summaryModel = value;
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Best-effort only; a failure here must never affect the session.
	}
}

export default function (pi: {
	on: (event: string, handler: (event: any, ctx: any) => unknown) => void;
}) {
	pi.on("session_start", (_event, ctx) => {
		syncToModel(ctx?.model);
	});

	pi.on("model_select", (event, ctx) => {
		syncToModel(event?.model ?? ctx?.model);
	});
}
