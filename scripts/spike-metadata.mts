/**
 * M0 day-0 spike — verify the measurement mechanic before building on it.
 *
 *   node scripts/spike-metadata.mts
 *
 * 1. POST one minimal completion DIRECTLY to the AI Gateway custom-provider endpoint (bypasses the
 *    worker) with a `cf-aig-metadata: { run_id, mode:"spike" }` header.
 * 2. Poll the Logs API and confirm a row appears carrying that run_id with a nonzero tokens_in.
 * 3. Print the raw log object so we can confirm the exact field names (metadata / tokens_in) the
 *    harness relies on, and eyeball ingestion lag.
 *
 * Requires in .dev.vars: HEROKU_INFERENCE_KEY (upstream auth) and CF_API_TOKEN (AI Gateway → Read).
 */
import { loadConfig } from "./lib/env.mts";
import { fetchRecentLogs } from "./lib/gateway.mts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	const cfg = loadConfig({ requireApiToken: true });
	if (!cfg.herokuKey) throw new Error("HEROKU_INFERENCE_KEY missing from .dev.vars — needed for the direct gateway call.");

	const runId = `spike-${Date.now()}`;
	const url = `https://gateway.ai.cloudflare.com/v1/${cfg.cfAccountId}/${cfg.gatewayId}/custom-${cfg.providerSlug}/v1/chat/completions`;
	console.log(`POST → ${url}\n  cf-aig-metadata: {"run_id":"${runId}","mode":"spike"}`);

	const res = await fetch(url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${cfg.herokuKey}`,
			"content-type": "application/json",
			"cf-aig-metadata": JSON.stringify({ run_id: runId, mode: "spike" }),
		},
		// No `temperature`: claude-opus-4-8 on this endpoint rejects the argument (400).
		body: JSON.stringify({
			model: cfg.model,
			messages: [{ role: "user", content: "Reply with the single word: ok" }],
			max_tokens: 8,
		}),
	});
	const body = await res.text();
	console.log(`  gateway responded ${res.status}${res.ok ? "" : `: ${body.slice(0, 300)}`}`);
	if (!res.ok) {
		console.error("\n✗ The gateway rejected the tagged request. If the cf-aig-metadata header is the cause,");
		console.error("  fall back to time-window correlation (see TOKEN-OPTIMIZATION.md risks).");
		process.exit(1);
	}

	console.log("\nPolling Logs API for the tagged row (metadata match, client-side) …");
	const deadline = Date.now() + 90_000;
	let delay = 2_000;
	let attempts = 0;
	const started = Date.now();
	while (Date.now() < deadline) {
		attempts++;
		const { rows, raw } = await fetchRecentLogs(cfg, 20);
		const match = rows.find((r) => r.runId === runId);
		if (match) {
			const lagS = ((Date.now() - started) / 1000).toFixed(1);
			console.log(`\n✓ Matched after ${attempts} poll(s) (~${lagS}s ingestion lag).`);
			console.log(`  tokens_in=${match.tokensIn}  tokens_out=${match.tokensOut}  run_id=${match.runId}  mode=${match.mode}`);
			const rawMatch = (raw as Record<string, unknown>[]).find((e) => JSON.stringify(e).includes(runId));
			console.log("\n  Raw log object (confirm field names for the harness):");
			console.log(
				JSON.stringify(rawMatch, null, 2)
					.split("\n")
					.map((l) => `    ${l}`)
					.join("\n"),
			);
			if (match.tokensIn <= 0) console.log("\n  ⚠ tokens_in is 0 — check the field name in the raw object above.");
			console.log("\nNext: record the working lookup strategy + lag in TOKEN-OPTIMIZATION.md, then run `npm run measure`.");
			return;
		}
		await sleep(delay);
		delay = Math.min(delay + 2_000, 10_000);
	}
	console.error("\n✗ No matching log row within 90s.");
	console.error("  The request may not carry metadata in the logs, or ingestion is slow. Inspect a raw row:");
	const { raw } = await fetchRecentLogs(cfg, 3);
	console.error(JSON.stringify(raw, null, 2));
	process.exit(1);
}

main().catch((err) => {
	console.error(`\nSpike failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
