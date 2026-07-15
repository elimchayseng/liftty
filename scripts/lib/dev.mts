/**
 * Dev-server client — talks to a local `wrangler dev` (default http://localhost:8787).
 *
 * Endpoints reused as-is from the worker:
 *   - GET  /plan                     → health check (renders once state is warm)
 *   - GET  /reseed?token=<RESEED>     → reset the DO to the pristine seed between runs
 *   - GET  /state?token=<RESEED>     → snapshot lifts/sessions for behavioral assertions
 *   - POST /agents/liftty-agent/me    → one chat flow; pass runId to tag+pin (measured run)
 */
import type { Config } from "./env.mts";

const AGENT_PATH = "/agents/liftty-agent/me";

export type ChatResponse = {
	reply: string;
	mode: "tools" | "codemode";
	toolsUsed: string[];
	steps: number;
	usageIn: number; // SDK-reported input tokens for the whole flow (token source of truth under streaming)
	usageOut: number;
	runId?: string;
	model?: string;
	code?: string[];
};

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	opts: { retries?: number; timeoutMs?: number; label: string },
): Promise<Response> {
	const retries = opts.retries ?? 3;
	const timeoutMs = opts.timeoutMs ?? 30_000;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await fetch(url, { ...init, signal: ac.signal });
			clearTimeout(timer);
			return res;
		} catch (err) {
			clearTimeout(timer);
			lastErr = err;
			if (attempt < retries) await sleep(500 * attempt);
		}
	}
	throw new Error(`${opts.label} failed after ${retries} attempts: ${String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** GET /plan until it answers 200 — proves the worker booted and the DO is reachable. */
export async function health(cfg: Config): Promise<void> {
	const res = await fetchWithRetry(`${cfg.baseUrl}/plan`, { method: "GET" }, { label: "health(/plan)", retries: 5, timeoutMs: 15_000 });
	if (!res.ok) throw new Error(`health(/plan) returned ${res.status}. Is \`wrangler dev\` running on ${cfg.baseUrl}?`);
}

/**
 * Reset DO state to the pristine seed. The flow mutates state, so this runs before every measured run.
 * When `sessions` is a positive number, seed that many logged sessions (for the analysis/history flows).
 */
export async function reseed(cfg: Config, sessions?: number): Promise<void> {
	let url = `${cfg.baseUrl}/reseed?token=${encodeURIComponent(cfg.reseedToken)}`;
	if (typeof sessions === "number" && sessions > 0) url += `&sessions=${sessions}`;
	const res = await fetchWithRetry(url, { method: "GET" }, { label: "reseed", retries: 3, timeoutMs: 15_000 });
	if (res.status === 404) throw new Error("reseed is disabled — set RESEED_TOKEN in .dev.vars and restart wrangler dev.");
	if (res.status === 403) throw new Error("reseed forbidden — the harness RESEED_TOKEN does not match the worker's.");
	if (!res.ok) throw new Error(`reseed returned ${res.status}`);
}

/** Snapshot the DO's behavioral state (lifts keyed by exact exercise name, session count, active logged sets). */
export async function readState(
	cfg: Config,
): Promise<{ ok: boolean; lifts: Record<string, number>; sessions: number; activeLoggedSets: number }> {
	const url = `${cfg.baseUrl}/state?token=${encodeURIComponent(cfg.reseedToken)}`;
	const res = await fetchWithRetry(url, { method: "GET" }, { label: "state", retries: 3, timeoutMs: 15_000 });
	const text = await res.text();
	if (!res.ok) throw new Error(`state returned ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as { ok: boolean; lifts: Record<string, number>; sessions: number; activeLoggedSets: number };
}

/** Run one chat flow. With a runId the worker tags gateway requests (cf-aig-metadata) and pins temp 0. */
export async function chat(
	cfg: Config,
	body: {
		message: string;
		mode: "tools" | "codemode";
		runId?: string;
		model?: string;
		variant?: "parallel-nudge" | "parallel-strong" | "one-snippet";
		decoys?: number;
	},
): Promise<ChatResponse> {
	// Only include the optional A/B axes in the POST body when defined, so baseline runs stay unchanged.
	const payload: Record<string, unknown> = { message: body.message, mode: body.mode };
	if (body.runId !== undefined) payload.runId = body.runId;
	if (body.model !== undefined) payload.model = body.model;
	if (body.variant !== undefined) payload.variant = body.variant;
	if (body.decoys !== undefined) payload.decoys = body.decoys;
	const res = await fetchWithRetry(
		`${cfg.baseUrl}${AGENT_PATH}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
		{ label: `chat(${body.mode})`, retries: 3, timeoutMs: 120_000 },
	);
	const text = await res.text();
	if (!res.ok) throw new Error(`chat(${body.mode}) returned ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text) as ChatResponse;
}
