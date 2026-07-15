# Side quest — observability-driven token optimization (Code Mode)

## Intention & desired outcome (the point of this)

**I want to prove, and then operationalize, that Code Mode reduces LLM _input-token_ consumption — using Cloudflare AI Gateway observability as the measurement and the optimization signal.**

Concretely, the outcome I'm after has two levels:

1. **Prove it (Phase 1).** For one identical end-to-end agent flow, show the input tokens consumed by the **regular typed-tools path** vs. the **Code Mode path**, sourced entirely from **AI Gateway observability** (the logs/usage the dashboard already records). The deliverable is a credible, gateway-sourced number and delta — evidence that Code Mode is not just architecturally cleaner but *measurably cheaper on input tokens*, and that **existing AI Gateway observability is enough to measure and optimize an agent's token efficiency**.

2. **Close the loop (Phase 2).** Design (and prototype) a **goal-based optimization loop** that automatically applies **tool transformations** to drive input tokens down, where **AI Gateway observability (input tokens per flow) is the success criterion / fitness function**, and **behavioral equivalence is the hard constraint** so the optimizer can't "win" by breaking the agent. The point is a forward-looking, self-optimizing agent pattern where the platform's own observability closes the optimization loop.

**Why this matters (framing):** it demonstrates observability-driven agent optimization end to end — measure with the gateway, then let the gateway's own signal drive an automated search that makes the agent cheaper without changing what it does. Code Mode is the first, hand-authored point on that optimization curve; Phase 2 automates the rest of the curve.

**Definition of done**
- **Phase 1 done when:** I can show, from AI Gateway logs alone, `avg input tokens / flow` for `tools` vs `codemode` on the same flow (mean + spread over N runs), with the requests correctly grouped per flow. Result drops into the case-study page.
- **Phase 2 done when:** a loop can take the current tool definitions, propose transformations, measure input tokens via the gateway, verify behavioral equivalence, and return a variant that uses fewer input tokens for the same flow with identical behavior — plus a written design of how it works and where it stops.

---

## Locked requirements (decided)

| Decision | Choice | Notes |
|---|---|---|
| **Token source of truth** | **AI Gateway logs only** | Confirmed the gateway captures per-request `in`/`out` for the custom Heroku provider (dashboard shows e.g. `3760 in / 9 out`). No AI-SDK fallback. |
| **The e2e flow** | **One fixed prompt** (the "money prompt"), ~~temperature 0~~, **N=5 runs** per mode | Report median + spread. ⚠ `temperature` is rejected by `claude-opus-4-8` on this endpoint (see Status) — dropped; N-run medians handle determinism. The multi-step nature is what exposes the gap. |
| **Phase 2 correctness constraint** | **Behavioral-equivalence eval** (golden outputs) | A token drop only counts if behavior is preserved. Strong enough to run unattended. |
| **Phase 2 transformation scope** | **(a) tool schema/description trimming** and **(b) tool consolidation / packaging** only | Out of scope: return-shape projection, system/`CODEMODE_HINT` prompt compression. |

**The fixed flow (money prompt):**
> "Log today's front squats: 5×225, 5×225, 8×225. Did I PR versus my history? If my top set beat my current prescription, bump next week's front squat by 5 lb."

Run identically in `mode:"tools"` (M2 baseline, 4 tools one-at-a-time) and `mode:"codemode"` (M3, one snippet).

---

## The core measurement mechanic — grouping a flow's requests

One flow = **several** gateway requests (one per model step in the `generateText` loop). The gateway log has no "flow" column, so raw rows can't be attributed to a flow. Fix:

- Tag every model call in a flow with a **`cf-aig-metadata`** header carrying `{ run_id, mode }`.
- All of a flow's steps originate from a single `onRequest`, so the tag is set **once per flow**.
- Then filter the gateway logs by `run_id` and **sum the `in` tokens** across that flow's rows → the honest per-flow input-token number.

This same grouping is what Phase 2's loop reads to score a candidate.

**Minimal code change:** thread an optional `runId` through `onRequest → getModel`, and attach the `cf-aig-metadata` header in `src/model.ts`.

---

## Phase 1 — measure (approach)

1. **Harness** (script, run against local `wrangler dev` — it still hits the real gateway, so logs are produced; no prod impact):
   - Reset DO to the pristine seed (the flow mutates state, so both modes must start identical).
   - Send the money prompt in `mode:"tools"`, tagged `{ run_id, mode:"tools" }`.
   - Reset; send in `mode:"codemode"`, tagged `{ run_id, mode:"codemode" }`.
   - Repeat ×5 per mode (unique `run_id` each).
2. **Read back** from the AI Gateway logs (programmatically), group by `run_id`, sum `in` tokens per flow; also capture `# requests / flow` and output tokens for context.
3. **Report** a table: `mode · avg input tokens/flow · # requests/flow · spread · delta`. Feeds the case-study page (`code-mode-comparison.html`).

**Expected shape of result** (from the earlier hand-analysis, to be replaced by measured numbers): `tools` ≈ several requests accumulating re-sent context; `codemode` ≈ ~2 requests, intermediate reads staying in the sandbox → materially fewer input tokens. Phase 1 replaces the estimate with gateway truth.

---

## Phase 2 — optimize (design)

**Loop:**
1. **Propose** a transformation within scope (trim a tool description/schema, or consolidate/package tools).
2. **Apply** to a working copy of the tool definitions (`src/training.ts` / Code Mode packaging).
3. **Run** the fixed flow on local dev (tagged), N runs.
4. **Score** = input tokens/flow from the **gateway** (the fitness function).
5. **Gate** = behavioral-equivalence eval (below). Keep the candidate only if **tokens dropped AND behavior held**; else revert.
6. Repeat until an iteration budget, a token-reduction target, or K no-improvement rounds.

**Behavioral-equivalence eval (the guardrail) — three gates:**
- (a) **Identical final DO state** after the flow (program · activeSession · sessions) — objective.
- (b) **Identical set of training method-calls + args** performed during the flow — objective.
- (c) **Judge check** that the final natural-language reply asserts the same key facts (PR verdict, what changed) — catches quality regressions (a)/(b) can't see.
- (a) and (b) are hard gates; (c) is a secondary gate.

**Success criterion (explicit):** minimize `input tokens / flow` (gateway-measured) subject to behavioral equivalence holding on the fixed flow.

---

## Dependencies

- **Cloudflare API token with AI Gateway → Read** (in `.dev.vars` as `CF_API_TOKEN`) to pull logs programmatically for summation. Needed for rigorous Phase 1 (N runs summed) and required for Phase 2. Without it, Phase 1 can be done by eyeballing the dashboard with `run_id` tags, but not automated.
- **Local `RESEED_TOKEN`** (or a local reset path) to reset DO state to seed between runs.
- Verify `cf-aig-metadata` is accepted for the custom provider and is filterable in the logs API (build-time check).

---

## Open decisions (Phase 2 — finalize before building)

1. **Who proposes transformations:** an **LLM meta-agent** that rewrites tool descriptions/schemas, vs. a fixed set of **mechanical rewrite operators** (e.g. "compress description to ≤N chars", "merge tools A+B"). Mechanical = controllable; LLM = broader search.
2. **How far "consolidation" can go:** **packaging / type-block only** (safe), vs. **actually merging tools** (risks changing product behavior — must stay inside the equivalence gate).
3. **Termination policy:** iteration budget vs. token-reduction target vs. K no-improvement rounds.

---

## Out of scope (this side quest)

- Output-token optimization, latency, and cost-in-dollars (context only, not the objective).
- Return-shape projection / truncation and system-prompt/`CODEMODE_HINT` compression (deliberately excluded from the transformation scope).
- Changing the model, provider, or the gateway topology.

---

## Status

**Phase 1 — DONE (2026-07-07).** Tagging + harness built; measured live against local `wrangler dev` reading AI Gateway logs. **The result inverted the hypothesis, in an interesting way.**

Full matrix — 3 models × 2 modes × 2 flows, median input tokens/flow, N=5, gateway-sourced. **Code Mode wins exactly 1 of 12 cells.**

| flow | model | tools | codemode | Code Mode |
|---|---|---|---|---|
| parallelizable | opus-4-8 | 5,773 (2 steps) | 6,614 (2) | **+15% (more)** |
| parallelizable | sonnet-4-5 | 9,643 (3 steps) | 5,790 (2) | **−40% (CHEAPER)** ✅ |
| parallelizable | haiku-4-5 | 4,947 (2 steps) | 4,987 (2) | **+1% (wash)** |
| sequential | opus-4-8 | 10,207 (3.3) | 11,833 (3.0) | **+16% (more)** |
| sequential | sonnet-4-5 | 8,293 (3.4) | 13,903 (4.6) | **+68% (more)** |
| sequential | haiku-4-5 | 10,407 (3.4) | 15,642 (4.4) | **+50% (more)** |

**Why:** Code Mode trades a fixed ~800-token overhead (generated `training.*` type block + `CODEMODE_HINT`, every request) for removed round-trips. It only removes round-trips when the model would otherwise **serialize** independent calls AND the task is **parallelizable** (one upfront snippet). That's Sonnet + parallelizable — the only win. **Batching models (Opus, Haiku) never benefit** (already 2 round-trips; overhead is dead weight) — and batching is model-specific, not size-ordered (Haiku is smallest yet batches like Opus). **Sequential/dependent flows make Code Mode *worse* for every model** — the models interleave (deload in one snippet, then read+set in another) instead of collapsing to one, so steps go *up* (4.4–4.6 vs 3.4); smaller models also fumble the dependent snippet (Sonnet stalls; Haiku deloads from the wrong base). The intuition "multi-step agents favor Code Mode" is measurably backwards here. Full writeup + decision guide in `code-mode-comparison.html`.

**Model override** (`--models opus,sonnet,haiku`) and a **sequential flow** (`--flows batchable,sequential`) added to the harness; `claude-sonnet-4-5` / `claude-haiku-4-5` confirmed available on the Heroku endpoint.

**Findings that fed back into the plan:**
- **`temperature` is unsupported** for `claude-opus-4-8` on the Heroku endpoint (400), and Anthropic has no seed — dropped temperature; determinism comes from N-run medians (spread is small). Supersedes the "temperature 0" locked requirement.
- **Retry double-counting:** the AI SDK occasionally retries a model call; the gateway logs both attempts under the same `run_id`, so naive summation double-counts. Harness now flags `requests > steps` and excludes those runs. (Relevant to Phase 2 scoring.)
- **Model override** threaded through `onRequest → getModel` (like `runId`) so the harness compares models without config edits.
- Spike confirmed: `cf-aig-metadata` round-trips into the logs as a nested `metadata` object with `tokens_in`/`tokens_out`; client-side match by `run_id`; ingestion lag ~7s.

**Harness:** `scripts/measure.mts` (+ `scripts/lib/*`), `scripts/spike-metadata.mts`. Run: `npm run measure -- --models opus,sonnet --modes tools,codemode --flows batchable,sequential --n 5`. Needs `CF_API_TOKEN` (AI Gateway → Read) + `RESEED_TOKEN` in `.dev.vars`.

### Phase 1b — hardening the study (done)

**Motivation.** A critical review of Phase 1 flagged that a sophisticated reader would object to: (1) **input-tokens-only** ignores that Code Mode changes the *output* profile too — at 5:1 pricing the verdicts shift; (2) **untested counterfactuals** — Sonnet's tools-mode loss is from serializing calls (promptable?), and the sequential Code Mode losses might be a `CODEMODE_HINT` artifact; (3) the deck was **stacked against Code Mode's advertised sweet spot** (few tools, tiny payloads); (4) **statistical honesty** — many cells are ties at N=5 with no spreads shown; (5) **prompt caching** discounts raw input ~10×; (6) **correctness contaminates cost cells** (smaller models diverge behaviorally in Code Mode).

**Methodology changes.**
- **Token source moved from AI Gateway logs → the AI SDK's own `result.totalUsage`.** Reason: heavy flows require **streaming** (Heroku Managed Inference rejects long non-streaming completions with "Request timed out. Please use streaming…", and the SDK's retries then double-count in gateway logs). But **AI Gateway does NOT log token counts for streamed custom-provider responses** — verified `tokens_in=0` even after injecting `stream_options.include_usage` (the SDK reads the usage chunk; the gateway doesn't). SDK usage is validated equivalent to the earlier gateway numbers (opus·tools·batchable: SDK 5,773 vs gateway 5,777). The `cf-aig-metadata {run_id,mode,model,variant,decoys}` tag still groups requests for observability; only the token number now comes from the SDK. **This gateway-streaming gap is itself a finding.**
- **Harness fixes:** exclude partial runs from stats (not just retries); add `$`-adjusted in-equiv metric + `medianOut`; a **tie heuristic** (`|Δmedian| < max stdev` → "no measurable difference"); per-run behavioral assertion (`stateOk`) so cost is reported only for behaviorally-clean runs; per-run resilience (a timeout skips one run, never aborts the matrix).
- **New worker axes:** `variant` (`parallel-nudge` appends a batch-together instruction in tools mode; `one-snippet` replaces `CODEMODE_HINT` with a strict "one snippet only" hint), `decoys` (N deterministic no-op tools added to **both** surfaces to scale API size), `reseed(sessions=N)` (synthetic history for fat reads), `/state` debug route for assertions, `getHistory` cap 50→200. Streaming via `streamText` + `consumeStream`.

**Results** (median tokens, N=5; raw input / `$`-adj in-equiv = `tokensIn + 5×tokensOut` at the 5:1 output:input list ratio; tie = within noise):

| flow | model | tools | codemode | raw Δ | $-adj Δ | steps t→c | correct t/c | verdict |
|---|---|---|---|---|---|---|---|---|
| batchable | opus | 5,775 | 6,618 | +15% | −2% | 2→2 | 5/5·5/5 | wash ($-adj) |
| batchable | sonnet | 9,630 | 4,949 | −49% | −29% | 3→2 | 5/5·5/5 | **Code Mode win** |
| batchable | haiku | 4,956 | 10,466 | +111% | +82% | 2.4→3.2 | 5/5·3/5 | CM loses + unreliable (noisy, sd~4-5k) |
| sequential | opus | 16,368 | 12,250 | −25% | −20% | 3.6→3.0 | 5/5·5/5 | CM cheaper but HIGH VARIANCE (flipped sign vs Phase 1) |
| sequential | sonnet | 12,962 | 14,566 | +12% | +67% | 4→4 | 5/5·**1/5** | contaminated — CM fails behaviorally |
| sequential | haiku | 10,412 | 15,971 | +53% | +99% | 3.4→5.0 | 4/5·**0/5** | CM broken |
| analysis (100 sess) | opus | 12,432 | 13,430 | +8% | +7% | 2→2 | 5/5·5/5 | TIE |
| analysis (100 sess) | sonnet | 9,922 | 6,015 | −39% | −30% | 2→2.6 | 5/5·5/5 | TIE (sd 10,975 — noisy) |
| analysis (100 sess) | haiku | 9,934 | 11,835 | +19% | +43% | 2→3.2 | 5/5·5/5 | TIE |
| batchable d8 | opus | 8,115 | 9,321 | +15% | +1% | 2→2 | — | CM loses (wash $-adj) |
| batchable d20 | opus | 11,271 | 13,054 | +16% | +6% | 2→2 | — | CM loses |
| batchable d8 | sonnet | 12,252 | 7,888 | −36% | −25% | 3→2 | — | CM win persists |
| batchable d20 | sonnet | 15,809 | 11,352 | −28% | −26% | 3→2 | — | CM win persists |

**Objection experiments.**
- **Obj 1 (just prompt Sonnet to batch):** `parallel-nudge` on sonnet·tools·batchable → 9,630→9,695 tokens, 3.0→2.8 steps — **no real effect**; the green cell survives (batching is not reliably promptable). Opus control unchanged (5,775→5,866). **Escalation (`parallel-strong`, Anthropic's documented `<use_parallel_tool_calls>` block): Sonnet finally batched (6+ calls in one turn) but CORRUPTED a tool-call name (`getProgram" -->`) — the endpoint's `[a-zA-Z0-9_-]+` validator rejected the follow-up turn and the flow died with an empty reply in 4/5 runs.** Opus control clean (6,126; the block itself costs ~+350). So the green cell survives its strongest documented counterfactual — with the sharper lesson that prompting can induce batching but not induce it *correctly* on this stack.
- **Obj 2 (sequential loss is a hint artifact):** `one-snippet` on codemode·sequential → opus 12,250→11,500 (3.0→2.8 steps, 5/5 correct) slightly better; sonnet 14,566→15,022 (0/5 correct) worse; haiku 15,971→13,376 (1/5) still broken. **Penalty is real, not just the hint.**
- **Obj 3 (home turf):** analysis flow (fat intermediates) = ties for all models; tool-surface scaling (`decoys`) adds cost **symmetrically** to both modes (both send all tool definitions every request), so it never rescues Code Mode — for opus the gap even *widens* (843→1,783 tokens at 0→20 decoys). **The lever is round-trips, not tool count.**

**Conclusions.** Code Mode's token win is narrow — it needs a model that does NOT batch parallel calls (Sonnet; Opus & Haiku batch) AND a parallelizable flow. `$`-adjustment turns Opus's loss into a wash. Sequential flows are high-variance and, for smaller models, **behaviorally broken** in Code Mode. Caching caveat: raw-input deltas shrink under prompt caching (~10× on cached prefixes) — the durable signal is **round-trip count and output volume**, not raw input. Code Mode's model-independent value stays architectural (capability isolation, one-tool surface).

**Public-record cross-reference (done, 2026-07-08):** findings checked against Cloudflare's posts (launch post: qualitative only, zero token numbers; 81% = undisclosed-model parallel-batch demo; 99.9% = lazy discovery, NOT code execution), Anthropic (98.7% = on-demand tool-definition loading — a mechanism `createCodeTool` doesn't implement; PTC post = 37% on dependent chains in an intermediates-out-of-context harness — architecture difference explains the sign flip vs our sequential result), CodeAct (Wang et al. 2024 — capability gradient strongly confirms our 5/5·1/5·0/5 pass rates), Bifrost/Block benchmarks (frontier-only savings, "smaller models might struggle" caveats), Speakeasy (96% reduction with NO code execution — lazy discovery works for classic tools too). Conclusion: our batching finding (a) and per-tier correctness data (c) appear novel; (d) corrects the community conflation of code-execution with lazy-discovery savings; case-study page rewritten as story-first with a dedicated "what the vendors actually claim" section + inline citations. Known limitations kept explicit: fat-read tie is unproven either way (uninstrumented `getHistory` limit + codemode's ~6k result-truncation budget).

**Phase 2 — not started.** The optimizer's first concrete target is now clear: trim Code Mode's fixed schema/hint overhead (the ~800 tokens this measurement exposed), **now measured across tool counts** (the decoy curve). Note that the **tool-surface scaling curve and the hint variants (`parallel-nudge` / `one-snippet`) are exactly the transformation space a Phase 2 optimizer would search** — so these Phase 1b experiments double as its baseline. Gateway/SDK-measured tokens/flow remains the fitness function; behavioral-equivalence eval remains the gate.
