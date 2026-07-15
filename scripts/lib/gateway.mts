/**
 * Cloudflare AI Gateway Logs API client — the token source of truth.
 *
 * One agent flow = several gateway requests (one per model step in the generateText loop). The log
 * has no "flow" column, so we tag every request with `cf-aig-metadata: { run_id, mode }` (set once
 * per flow in the worker) and group here by run_id, summing `tokens_in`.
 *
 * Strategy: fetch the most recent logs and match `run_id` CLIENT-SIDE. Runs are strictly serial and
 * a flow is ≤8 rows, so the newest page always contains the flow we just ran — no server-side
 * metadata filter needed (that path is verified separately by scripts/spike-metadata.mts, and can be
 * swapped in here if preferred). Metadata field names vary across API versions, so extraction is
 * defensive; `scripts/spike-metadata.mts` prints the raw shape to confirm.
 */
import type { Config } from "./env.mts";

export type LogRow = {
	id: string;
	createdAt: string;
	tokensIn: number;
	tokensOut: number;
	runId?: string;
	mode?: string;
};

const API_BASE = "https://api.cloudflare.com/client/v4";

function num(v: unknown): number {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
	return Number.isFinite(n) ? n : 0;
}

/** Pull { run_id, mode } out of a log entry regardless of which field/shape the API used. */
function extractMeta(entry: Record<string, unknown>): { runId?: string; mode?: string } {
	const candidates = [entry.metadata, entry.custom_metadata, entry.request_metadata, entry.meta];
	for (const c of candidates) {
		let obj: Record<string, unknown> | undefined;
		if (typeof c === "string") {
			try {
				obj = JSON.parse(c) as Record<string, unknown>;
			} catch {
				obj = undefined;
			}
		} else if (c && typeof c === "object") {
			obj = c as Record<string, unknown>;
		}
		if (obj && (obj.run_id != null || obj.mode != null)) {
			return { runId: obj.run_id != null ? String(obj.run_id) : undefined, mode: obj.mode != null ? String(obj.mode) : undefined };
		}
	}
	return {};
}

function toRow(entry: Record<string, unknown>): LogRow {
	const meta = extractMeta(entry);
	return {
		id: String(entry.id ?? ""),
		createdAt: String(entry.created_at ?? entry.createdAt ?? ""),
		tokensIn: num(entry.tokens_in ?? entry.tokensIn),
		tokensOut: num(entry.tokens_out ?? entry.tokensOut),
		runId: meta.runId,
		mode: meta.mode,
	};
}

/** Fetch the most recent N logs (raw rows mapped to LogRow). Used by both the poller and the spike. */
export async function fetchRecentLogs(cfg: Config, perPage = 50): Promise<{ rows: LogRow[]; raw: unknown }> {
	const url = `${API_BASE}/accounts/${cfg.cfAccountId}/ai-gateway/gateways/${cfg.gatewayId}/logs?per_page=${perPage}&order_by=created_at&order_by_direction=desc`;
	const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.cfApiToken}`, "content-type": "application/json" } });
	const text = await res.text();
	if (!res.ok) throw new Error(`AI Gateway logs API returned ${res.status}: ${text.slice(0, 400)}`);
	const json = JSON.parse(text) as { result?: unknown[]; success?: boolean; errors?: unknown };
	if (!json.success) throw new Error(`AI Gateway logs API error: ${JSON.stringify(json.errors)?.slice(0, 400)}`);
	const rows = (json.result ?? []).map((e) => toRow(e as Record<string, unknown>));
	return { rows, raw: json.result };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the logs API until at least `expectCount` rows tagged with `runId` appear (logs are ingested
 * asynchronously), or `timeoutMs` elapses. On timeout returns whatever matched with `partial: true`
 * — logs persist, so a partial flow can be re-summed later.
 */
export async function logsForRun(
	cfg: Config,
	runId: string,
	opts: { expectCount: number; timeoutMs?: number },
): Promise<{ rows: LogRow[]; partial: boolean }> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const deadline = Date.now() + timeoutMs;
	let delay = 2_000;
	let best: LogRow[] = [];
	while (Date.now() < deadline) {
		const { rows } = await fetchRecentLogs(cfg, 50);
		const matched = rows.filter((r) => r.runId === runId);
		if (matched.length > best.length) best = matched;
		if (matched.length >= opts.expectCount) return { rows: matched, partial: false };
		await sleep(delay);
		delay = Math.min(delay + 2_000, 10_000);
	}
	return { rows: best, partial: true };
}
