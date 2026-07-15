/**
 * Config loader for the token-optimization harness.
 *
 * Sources, in precedence order: process.env → .dev.vars → wrangler.jsonc `vars`.
 * `.dev.vars` is a plain KEY=VALUE file; from wrangler.jsonc we regex-extract the four public vars
 * (regex is comment-proof, so we don't need a full JSONC parser). CF_API_TOKEN lives only here in
 * the harness — it is NEVER added to the worker Env; the worker never reads gateway logs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

export type Config = {
	baseUrl: string;
	cfApiToken: string;
	cfAccountId: string;
	gatewayId: string;
	providerSlug: string;
	model: string;
	reseedToken: string;
	herokuKey: string;
};

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

/** Pull a string `"key": "value"` out of wrangler.jsonc without parsing (comment/trailing-comma proof). */
function extractVar(jsonc: string, key: string): string {
	const m = jsonc.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
	return m ? m[1] : "";
}

export function loadConfig(opts: { requireApiToken?: boolean } = {}): Config {
	const dotvars = parseDotenv(safeRead(join(REPO_ROOT, ".dev.vars")));
	const wrangler = safeRead(join(REPO_ROOT, "wrangler.jsonc"));
	const fromEnvOrVars = (k: string): string => process.env[k] ?? dotvars[k] ?? "";

	const cfg: Config = {
		baseUrl: process.env.LIFTTY_BASE_URL ?? "http://localhost:8787",
		cfApiToken: fromEnvOrVars("CF_API_TOKEN"),
		reseedToken: fromEnvOrVars("RESEED_TOKEN"),
		herokuKey: fromEnvOrVars("HEROKU_INFERENCE_KEY"),
		cfAccountId: process.env.CF_ACCOUNT_ID ?? extractVar(wrangler, "CF_ACCOUNT_ID"),
		gatewayId: process.env.AI_GATEWAY ?? extractVar(wrangler, "AI_GATEWAY"),
		providerSlug: process.env.PROVIDER_SLUG ?? extractVar(wrangler, "PROVIDER_SLUG"),
		model: process.env.MODEL ?? extractVar(wrangler, "MODEL"),
	};

	const missing: string[] = [];
	if (opts.requireApiToken && !cfg.cfApiToken) {
		missing.push("CF_API_TOKEN — a Cloudflare API token with 'AI Gateway → Read'. Add it to .dev.vars.");
	}
	if (!cfg.reseedToken) {
		missing.push("RESEED_TOKEN — set a value in .dev.vars so the /reseed route is enabled.");
	}
	if (!cfg.cfAccountId || !cfg.gatewayId) {
		missing.push("CF_ACCOUNT_ID / AI_GATEWAY — expected in wrangler.jsonc vars.");
	}
	if (missing.length) {
		throw new Error(`Harness config incomplete:\n  - ${missing.join("\n  - ")}`);
	}
	return cfg;
}
