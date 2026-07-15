/**
 * Measurement orchestration: run the fixed "money prompt" N times per mode, strictly serial, and
 * report input tokens per flow sourced entirely from AI Gateway logs.
 */
import type { Config } from "./env.mts";
import { chat, reseed, readState } from "./dev.mts";

export type Mode = "tools" | "codemode";

/**
 * Flows under test. The comparison is only meaningful when the SAME prompt runs in both modes.
 *
 * - `batchable`: the original "money prompt" — reads + independent logs. A model that supports
 *   parallel tool calls collapses this to ~2 round-trips even in tools mode, so Code Mode's
 *   round-trip-collapsing advantage doesn't trigger. (Uses 145 lb, which is plausible for the seed
 *   so the coach actually logs, rather than the original 225 which it refuses.)
 * - `sequential`: a write→dependent-write chain. The second write's ARGUMENT (the exact post-deload
 *   Front Squat weight) is only knowable after the first write runs, so it genuinely cannot be
 *   batched — the model must deload, read the result, then set the matched weight. Chosen because
 *   both modes execute it identically (same final state: FS and Pause FS both land at 115), making
 *   it a clean A/B — unlike a floor-clamp, which caused tools mode to narrate instead of execute.
 */
export const FLOWS: Record<string, string> = {
	batchable:
		"Log today's front squats: 5×145, 5×145, 8×145. Did I PR versus my history? " +
		"If my top set beat my current prescription, bump next week's front squat by 5 lb.",
	sequential:
		"Deload every lift in my program by 10% for a recovery week. Then set my Pause Front Squat to " +
		"exactly match the new post-deload Front Squat weight so they move together. " +
		"Tell me both final weights.",
	// Read-only history read: forces a full-history sweep but must NOT mutate state, giving a clean
	// behavioral A/B (state before === state after) on top of the token comparison.
	analysis:
		"Review my entire logged history: for each of my three main lifts, how did the top working weight " +
		"trend block over block, and what's my total front squat volume (sets×reps×weight) across all logged " +
		"sessions? Do not change anything in my program.",
};

/** Back-compat alias used by Phase 2 / older callers. */
export const MONEY_PROMPT = FLOWS.batchable;

/** Convenience model aliases → the ids the Heroku endpoint accepts. */
export const MODELS: Record<string, string> = {
	opus: "claude-opus-4-8",
	sonnet: "claude-sonnet-4-5",
	haiku: "claude-haiku-4-5",
};

export type FlowResult = {
	runId: string;
	mode: Mode;
	model: string;
	flow: string;
	requests: number; // gateway rows matched for this flow
	steps: number; // model steps the worker reported (expected row count)
	tokensIn: number; // summed across the flow's rows
	tokensOut: number;
	inEquiv: number; // dollar-adjusted input-equivalent = tokensIn + 5 * tokensOut (5:1 list-price ratio)
	toolsUsed: string[];
	partial: boolean; // true if log ingestion didn't reach `steps` before timeout
	retry: boolean; // true if gateway rows > model steps → the AI SDK retried a request (rows double-count)
	variant?: "parallel-nudge" | "parallel-strong" | "one-snippet"; // optional prompt-shaping A/B axis
	decoys?: number; // optional decoy-tool count axis
	stateOk?: boolean; // per-flow behavioral assertion result (undefined if /state unreachable or N/A)
	reply: string;
};

export type ModeSummary = {
	mode: Mode;
	model: string;
	flow: string;
	n: number;
	meanIn: number;
	medianIn: number;
	minIn: number;
	maxIn: number;
	stdevIn: number;
	medianInEquiv: number; // dollar-adjusted median input-equivalent over clean runs
	meanInEquiv: number;
	medianOut: number; // median tokensOut over clean runs
	meanSteps: number;
	meanRequests: number;
	retryRuns: number; // count of runs whose gateway rows exceeded steps (excluded from clean stats)
	partialRuns: number; // count of partial runs (also excluded from clean stats)
	anyPartial: boolean;
};

function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(xs: number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export type Cell = {
	mode: Mode;
	model: string;
	flow: string;
	n: number;
	variant?: "parallel-nudge" | "parallel-strong" | "one-snippet";
	decoys?: number;
	sessions?: number;
};

/**
 * Two summaries tie when their median-input delta is smaller than the larger of the two stdevs —
 * i.e. the difference is within measurement noise, so no real winner can be claimed.
 */
export function isTie(a: ModeSummary, b: ModeSummary): boolean {
	return Math.abs(a.medianIn - b.medianIn) < Math.max(a.stdevIn, b.stdevIn);
}

/**
 * Compute the per-flow behavioral assertion. Returns undefined when /state is unreachable (snapshots
 * null) or the flow has no defined invariant.
 */
function computeStateOk(
	flow: string,
	before: Awaited<ReturnType<typeof readState>> | null,
	after: Awaited<ReturnType<typeof readState>> | null,
): boolean | undefined {
	if (!after) return undefined;
	switch (flow) {
		case "sequential":
			return after.lifts["Front Squat"] === 115 && after.lifts["Pause Front Squat (2s)"] === 115;
		case "batchable":
			return after.activeLoggedSets === 3;
		case "analysis":
			if (!before) return undefined;
			return (
				before.sessions === after.sessions &&
				JSON.stringify(before.lifts) === JSON.stringify(after.lifts)
			);
		default:
			return undefined;
	}
}

/** Run one (mode × model × flow) cell N times: reseed → tagged chat → sum the flow's gateway tokens. */
export async function measureFlow(cfg: Config, cell: Cell): Promise<FlowResult[]> {
	const prompt = FLOWS[cell.flow];
	if (!prompt) throw new Error(`unknown flow "${cell.flow}" (have: ${Object.keys(FLOWS).join(", ")})`);
	const axisTag = `${cell.variant ? "-" + cell.variant : ""}${cell.decoys ? "-d" + cell.decoys : ""}`;
	const results: FlowResult[] = [];
	for (let i = 0; i < cell.n; i++) {
		const runId = `${cell.flow}-${cell.mode}${axisTag}-${cell.model}-${Date.now()}-${i}`;
		const label = `${cell.model} · ${cell.flow}${axisTag} · ${cell.mode}`;
		process.stdout.write(`  [${label}] run ${i + 1}/${cell.n} … `);
		try {
			await reseed(cfg, cell.sessions);
			// Snapshot state before the chat for the read-only (analysis) assertion; tolerate /state absence.
			let before: Awaited<ReturnType<typeof readState>> | null = null;
			try {
				before = await readState(cfg);
			} catch {
				before = null;
			}
			const res = await chat(cfg, {
				message: prompt,
				mode: cell.mode,
				runId,
				model: cell.model,
				variant: cell.variant,
				decoys: cell.decoys,
			});
			// TOKEN SOURCE: the SDK's own per-flow usage (result.totalUsage), returned by the worker.
			// We stream to avoid Heroku's non-streaming timeout on heavy flows; AI Gateway does NOT log
			// token counts for streamed custom-provider responses (verified: tokens_in=0), but the SDK
			// reads the stream's usage chunk and its totals match the gateway's non-streaming numbers
			// (opus·tools·batchable: SDK 5,773 vs gateway 5,777). The cf-aig-metadata run_id tag still
			// groups the flow's requests for observability; only the token *number* comes from the SDK.
			const tokensIn = res.usageIn;
			const tokensOut = res.usageOut;
			const inEquiv = tokensIn + 5 * tokensOut; // 5:1 output:input list-price ratio → dollar-adjusted input
			// SDK usage is a single per-flow total, so retry double-counting and ingestion-partials can't
			// occur; keep the fields false for schema compatibility with earlier gateway-sourced results.
			const partial = false;
			const retry = false;
			// Read state after the flow, then assert the per-flow invariant. Tolerate /state absence.
			let after: Awaited<ReturnType<typeof readState>> | null = null;
			try {
				after = await readState(cfg);
			} catch {
				after = null;
			}
			const stateOk = computeStateOk(cell.flow, before, after);
			results.push({
				runId,
				mode: cell.mode,
				model: cell.model,
				flow: cell.flow,
				requests: res.steps, // one gateway request per model step (SDK usage is the token source)
				steps: res.steps,
				tokensIn,
				tokensOut,
				inEquiv,
				toolsUsed: res.toolsUsed,
				partial,
				retry,
				variant: cell.variant,
				decoys: cell.decoys,
				stateOk,
				reply: res.reply,
			});
			const stateTag = stateOk === undefined ? "" : stateOk ? " (state OK)" : " (STATE FAIL)";
			process.stdout.write(`${tokensIn} in · ${tokensOut} out · ${res.steps} steps${stateTag}\n`);
		} catch (err) {
			// One flaky run (e.g. Heroku "request timed out" → 502 after SDK retries) must NOT abort the whole
			// matrix. Record nothing for this run and continue; the cell just ends up with fewer clean samples.
			process.stdout.write(`FAILED — skipped (${err instanceof Error ? err.message.slice(0, 80) : String(err)})\n`);
		}
		// Small breather between runs to ease gateway/endpoint pressure and reduce timeout-driven retries.
		await new Promise((r) => setTimeout(r, 1500));
	}
	return results;
}

export function summarize(results: FlowResult[]): ModeSummary {
	// Exclude retry-inflated runs (sums double-count) AND partial runs (incomplete ingestion) from token
	// stats; fall back to all runs if every run was flagged. Median is the primary stat — robust to
	// the occasional straggler.
	const clean = results.filter((r) => !r.retry && !r.partial);
	const used = clean.length ? clean : results;
	const ins = used.map((r) => r.tokensIn);
	const inEquivs = used.map((r) => r.inEquiv);
	const outs = used.map((r) => r.tokensOut);
	const r0 = results[0];
	return {
		mode: r0.mode,
		model: r0.model,
		flow: r0.flow,
		n: used.length,
		meanIn: mean(ins),
		medianIn: median(ins),
		minIn: Math.min(...ins),
		maxIn: Math.max(...ins),
		stdevIn: stdev(ins),
		medianInEquiv: median(inEquivs),
		meanInEquiv: mean(inEquivs),
		medianOut: median(outs),
		meanSteps: mean(used.map((r) => r.steps)),
		meanRequests: mean(used.map((r) => r.requests)),
		retryRuns: results.filter((r) => r.retry).length,
		partialRuns: results.filter((r) => r.partial).length,
		anyPartial: results.some((r) => r.partial),
	};
}
