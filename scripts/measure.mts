/**
 * Phase 1 measurement CLI — measures input tokens/flow across a model × mode × flow matrix,
 * sourced entirely from AI Gateway logs (grouped by cf-aig-metadata run_id).
 *
 *   node scripts/measure.mts --models opus,sonnet --modes tools,codemode --flows batchable,sequential --n 3
 *   npm run measure -- --models opus,sonnet --flows batchable,sequential --n 3
 *
 * Requires a local `wrangler dev` (default http://localhost:8787) and, in .dev.vars:
 *   CF_API_TOKEN (AI Gateway → Read; harness-only) and RESEED_TOKEN (enables /reseed).
 *
 * Prints one comparison table per flow and writes the full per-run JSON.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, REPO_ROOT } from "./lib/env.mts";
import { health } from "./lib/dev.mts";
import { measureFlow, summarize, isTie, FLOWS, MODELS, type Cell, type FlowResult, type Mode, type ModeSummary } from "./lib/measure.mts";

type Variant = "parallel-nudge" | "parallel-strong" | "one-snippet";

type Args = {
	models: string[];
	modes: Mode[];
	flows: string[];
	n: number;
	variants: (Variant | undefined)[]; // one entry per variant axis value; undefined = baseline (no variant)
	decoys: (number | undefined)[]; // one entry per decoy-count axis value; undefined = no decoys param
	sessions?: number; // single value applied to all cells
	out?: string;
};

function parseList(v: string): string[] {
	return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Args {
	let models = ["opus"];
	let modes: Mode[] = ["tools", "codemode"];
	let flows = ["batchable"];
	let n = 5;
	// Default axes: a single baseline (no variant) and a single no-decoys value → back-compat matrix.
	let variants: (Variant | undefined)[] = [undefined];
	let decoys: (number | undefined)[] = [undefined];
	let sessions: number | undefined;
	let out: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--models" || a === "--model") models = parseList(argv[++i]);
		else if (a === "--modes" || a === "--mode") modes = parseList(argv[++i]) as Mode[];
		else if (a === "--flows" || a === "--flow") flows = parseList(argv[++i]);
		else if (a === "--n") n = parseInt(argv[++i], 10);
		// --variants a,b generates one cell-set per listed variant with NO implicit baseline. To include
		// baseline alongside a variant, pass it explicitly as "none": e.g. --variants none,parallel-nudge.
		else if (a === "--variants" || a === "--variant")
			variants = parseList(argv[++i]).map((v) => (v === "none" ? undefined : (v as Variant)));
		// --decoys 0,8,20 generates one cell-set per decoy count. Omit for the default (no decoys param).
		else if (a === "--decoys" || a === "--decoy") decoys = parseList(argv[++i]).map((d) => parseInt(d, 10));
		else if (a === "--sessions") sessions = parseInt(argv[++i], 10);
		else if (a === "--out") out = argv[++i];
	}
	// "both" back-compat for --mode
	if (modes.length === 1 && (modes[0] as string) === "both") modes = ["tools", "codemode"];
	for (const m of modes) if (m !== "tools" && m !== "codemode") throw new Error(`bad mode "${m}"`);
	for (const f of flows) if (!FLOWS[f]) throw new Error(`bad flow "${f}" (have: ${Object.keys(FLOWS).join(", ")})`);
	if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer (got ${n})`);
	for (const v of variants)
		if (v !== undefined && v !== "parallel-nudge" && v !== "parallel-strong" && v !== "one-snippet") throw new Error(`bad variant "${v}" (have: parallel-nudge, parallel-strong, one-snippet, none)`);
	for (const d of decoys) if (d !== undefined && (!Number.isInteger(d) || d < 0)) throw new Error(`--decoys values must be non-negative integers`);
	if (sessions !== undefined && (!Number.isInteger(sessions) || sessions < 1)) throw new Error(`--sessions must be a positive integer (got ${sessions})`);
	return { models, modes, flows, n, variants, decoys, sessions, out };
}

/** Resolve a model alias (opus/sonnet/haiku) to its endpoint id; pass raw ids through. */
function resolveModel(m: string): string {
	return MODELS[m] ?? m;
}

function gitSha(): string {
	try {
		return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
	} catch {
		return "unknown";
	}
}

function fmt(n: number): string {
	return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function shortModel(id: string): string {
	return id.replace(/^claude-/, "").replace(/^us\.anthropic\./, "");
}

type CellResult = { summary: ModeSummary; runs: FlowResult[] };

/** Mean behavioral-assertion pass rate for a cell's runs: "ok/defined" or "-" when no run measured state. */
function stateOkCell(runs: FlowResult[]): string {
	const defined = runs.filter((r) => r.stateOk !== undefined);
	if (!defined.length) return "-";
	const ok = defined.filter((r) => r.stateOk === true).length;
	return `${ok}/${defined.length}`;
}

/** One table per flow: rows = model × mode (× variant × decoys), plus a codemode-vs-tools delta per model. */
function printFlowTable(flow: string, cellResults: CellResult[]): void {
	console.log(`\n=== flow: ${flow} — input tokens/flow (AI Gateway logs; median primary, retries+partials excluded) ===\n`);
	const header = ["model", "mode", "variant", "median in", "in-equiv", "min–max", "mean in", "med out", "steps", "reqs", "±stdev", "n", "retry", "partial", "state"];
	const rows = cellResults.map(({ summary: s, runs }) => [
		shortModel(s.model),
		s.mode,
		runs[0]?.variant ?? (runs[0]?.decoys !== undefined ? `d${runs[0].decoys}` : "-"),
		fmt(s.medianIn),
		fmt(s.medianInEquiv),
		`${fmt(s.minIn)}–${fmt(s.maxIn)}`,
		fmt(s.meanIn),
		fmt(s.medianOut),
		s.meanSteps.toFixed(1),
		s.meanRequests.toFixed(1),
		fmt(s.stdevIn),
		String(s.n),
		s.retryRuns ? String(s.retryRuns) : "-",
		s.partialRuns ? String(s.partialRuns) : "-",
		stateOkCell(runs),
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
	console.log(line(header));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const r of rows) console.log(line(r));

	// Per-model codemode-vs-tools delta (matches the first cell per mode — meaningful for a single-axis run).
	const models = [...new Set(cellResults.map((c) => c.summary.model))];
	for (const model of models) {
		const t = cellResults.find((cr) => cr.summary.model === model && cr.summary.mode === "tools")?.summary;
		const c = cellResults.find((cr) => cr.summary.model === model && cr.summary.mode === "codemode")?.summary;
		if (t && c && t.medianIn > 0) {
			if (isTie(t, c)) {
				console.log(
					`  ${shortModel(model)}: TIE (no measurable difference) — |Δ median in| ${fmt(Math.abs(c.medianIn - t.medianIn))} < ` +
						`max stdev ${fmt(Math.max(t.stdevIn, c.stdevIn))} ` +
						`(tools ${t.meanSteps.toFixed(1)} steps → codemode ${c.meanSteps.toFixed(1)} steps).`,
				);
				continue;
			}
			const diff = c.medianIn - t.medianIn; // >0 → Code Mode costs MORE
			const pct = (Math.abs(diff) / t.medianIn) * 100;
			const verb = diff < 0 ? "CHEAPER" : "more expensive";
			const eqDiff = c.medianInEquiv - t.medianInEquiv;
			const eqPct = t.medianInEquiv > 0 ? (Math.abs(eqDiff) / t.medianInEquiv) * 100 : 0;
			const eqVerb = eqDiff < 0 ? "CHEAPER" : "more expensive";
			console.log(
				`  ${shortModel(model)}: Code Mode is ${fmt(Math.abs(diff))} tokens (${pct.toFixed(1)}%) ${verb} on raw input, ` +
					`${fmt(Math.abs(eqDiff))} (${eqPct.toFixed(1)}%) ${eqVerb} on $-adjusted in-equiv ` +
					`(tools ${t.meanSteps.toFixed(1)} steps → codemode ${c.meanSteps.toFixed(1)} steps).`,
			);
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cfg = loadConfig({ requireApiToken: true });
	console.log(`Checking wrangler dev at ${cfg.baseUrl} …`);
	await health(cfg);

	const cells: Cell[] = [];
	for (const flow of args.flows)
		for (const model of args.models)
			for (const mode of args.modes)
				for (const variant of args.variants)
					for (const decoyCount of args.decoys)
						cells.push({ flow, model: resolveModel(model), mode, n: args.n, variant, decoys: decoyCount, sessions: args.sessions });

	console.log(
		`\nMatrix: ${args.flows.length} flow(s) × ${args.models.length} model(s) × ${args.modes.length} mode(s)` +
			` × ${args.variants.length} variant(s) × ${args.decoys.length} decoy-set(s), N=${args.n} → ${cells.length} cells\n`,
	);

	const allRuns: FlowResult[] = [];
	const cellResults: CellResult[] = [];
	for (const cell of cells) {
		const runs = await measureFlow(cfg, cell);
		allRuns.push(...runs);
		cellResults.push({ summary: summarize(runs), runs });
	}
	const summaries: ModeSummary[] = cellResults.map((c) => c.summary);

	for (const flow of args.flows) {
		printFlowTable(flow, cellResults.filter((c) => c.summary.flow === flow));
	}
	if (summaries.some((s) => s.anyPartial)) {
		console.log("\n⚠ Some flows were PARTIAL (log ingestion lag). Re-run or re-poll those cells.");
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath = args.out ?? join(REPO_ROOT, "results", `phase1-matrix-${stamp}.json`);
	mkdirSync(join(REPO_ROOT, "results"), { recursive: true });
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				phase: 1,
				generatedAt: new Date().toISOString(),
				gitSha: gitSha(),
				flows: Object.fromEntries(args.flows.map((f) => [f, FLOWS[f]])),
				n: args.n,
				variants: args.variants,
				decoys: args.decoys,
				sessions: args.sessions,
				summaries,
				runs: allRuns,
			},
			null,
			2,
		),
	);
	console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
	console.error(`\nMeasurement failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
