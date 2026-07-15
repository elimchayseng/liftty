# PRODUCT-VISION.md — the golden end state for the middle of the spectrum

**Scope:** this document is NOT part of the demo build. `LOADERS-VS-WFP.md` argues the *problem* (the gap between Dynamic Workers and Workers for Platforms); this document sketches the *solution* — what the productized version of liftty's hand-rolled plugin machinery would look like as a Cloudflare platform feature, where it would sit in the product offering, and how it would be positioned. Date-stamped July 2026.

## The feature: a managed module registry on the Worker Loader

Working name here: `MODULES` (naming discussed below). The developer-facing shape, annotated against what liftty builds by hand in M5:

### Authoring path — runs once, when the lifter states a policy in chat

```js
// The agent (via a tool call) hands the platform the code it just wrote
const { id, version } = await env.MODULES.put(
  "auto-regulate",   // policy name — today: the `id` column + hand-built isolate id
  source,            // the JS the model wrote — the plugin.js body, unchanged
  {
    // Enforced entrypoint shape. Reject at put() if the model wrote the wrong export.
    // Today: the hand-written HARNESS_SRC wrapper + manual shape check.
    contract: "onSetLogged(event) -> {actions, note?}",

    // Mandatory dry-run against a fixture before the code is accepted.
    // Today: createPlugin() calling one-shot LOADER.load() on a synthetic event.
    validate: syntheticEvent,

    // Blast-radius rules declared once, enforced on every future execution.
    // Today: globalOutbound: null + limits passed manually on every get().
    capabilities: { outbound: "none", cpuMs: 50, bindings: [] }
  }
);
// Returned version — today: the `version` column + manual bump logic.
```

`put()` replaces the `plugins` SQLite table: the platform stores the source, scoped to the binding owner (per-DO, per-namespace, or account).

### Hot path — runs on every logged set, model nowhere in sight

```js
const result = await env.MODULES.get("auto-regulate").onSetLogged(event);
```

This one line replaces the entirety of `runPlugins()`: the `SELECT` of enabled rows, the `LOADER.get()` call with the version-stamped id, the cache-miss callback supplying harness + source, the try/catch, the `last_run`/`last_result` bookkeeping, and the JSON log line for `wrangler tail`. Isolate caching, capability enforcement, and metrics are the platform's job.

### The mapping, in one table

| liftty hand-rolls (M5) | Productized |
|---|---|
| `createPlugin()` — dry-run, shape-check, `INSERT` | `MODULES.put(name, source, {contract, validate, capabilities})` |
| `runPlugins()` — select, `LOADER.get()`, harness, try/catch, bookkeeping | `MODULES.get(name).onSetLogged(event)` |
| `plugins` SQLite table | Managed source storage |
| `plugin:${id}:v${version}` ids + version column | Automatic version history, `rollback()`, pinning, canary |
| `HARNESS_SRC` + manual shape check | Declared, enforced `contract` |
| Per-call `globalOutbound`/`limits` | `capabilities` manifest, declared once |
| `last_run`/`last_result` + `console.log` JSON lines | Per-module tail, dashboard analytics (invocations, p50/p99, cold rate, error rate) |
| (not built) | Auto-disable on error-rate threshold, kill switch |
| (not built) | Per-module billing attribution |
| (not built) | Declarative trigger binding: modules subscribe to DO-emitted events (tail-worker/queues-consumer pattern applied to agent code) + cron for scheduled modules |
| (not built) | Human approval gates: module versions requiring review before activation (enterprise) |
| (not built) | Graduation: `wrangler modules promote` → real Worker in a WfP dispatch namespace |

~200 lines of glue collapsing into two API calls. The compression ratio is the product argument.

Two rows deserve emphasis because they go beyond productizing what liftty built:

- **Trigger binding** removes the last piece of hand-rolled wiring — today the app manually calls the runner from the `log_set` path; declaratively, modules subscribe to events the DO emits. This is what makes the pattern zero-integration for agent builders.
- **Graduation** stitches the spectrum's two ends together: code born in the cheap, instant middle can retire into the fully managed right end (a real deployed WfP Worker) when it gets hot or important enough. Without it, the middle is a dead end; with it, it's the on-ramp.

## Placement in the product offering

Three options; the likely answer is a split:

1. **Primitive in Dynamic Workers** — the registry is mechanically an extension of the Loader; the `MODULES` binding lives here. Keeps the primitives-for-builders positioning intact.
2. **Not primarily in WfP** — WfP has the right *lifecycle* (versioning, observability, limits) attached to the wrong *ingestion model* (control-plane upload, deploy-scoped tokens, propagation latency, one-meaningful-script-per-tenant cardinality and pricing). Millions of ~30-line per-user policies as full deployed Workers is registering a company for every sticky note. Full argument in `LOADERS-VS-WFP.md` §4. WfP's role is the graduation *target*, not the home.
3. **DX surface in the Agents SDK** — `this.modules.create(...)` plus pre-built tools so any agent can author and manage its own modules out of the box.

The 1 + 3 split matches Cloudflare's established productization pattern: raw primitive first, SDK productizes the usage pattern (exactly the Durable Objects → Agents SDK arc). Predicting that specific split is the memo's roadmap call.

**The AX observation (new product consideration):** when the agent is the author, the lifecycle API's primary consumer is a model, not a human. That means schemas designed for tool-calling, validation errors structured so the model can self-correct the code and retry `put()`, docs shipped as llms.txt. Agent experience (AX) becomes a design discipline alongside DX — Cloudflare is already halfway there (docs MCP server, llms.txt on every page). The next developer persona doesn't read the docs; it's in the request.

## Marketing positioning

**The narrative arc.** Dynamic Workers' current story is act one: "sandbox AI-generated code, 100x faster" — safety and speed for *ephemeral* code. This feature is act two: **"and keep it."** Agents that run code → agents that *accumulate* code.

**Positioning angles, in order of strength:**

1. **Economics (CFO-facing):** "Stop renting inference for decisions you've already made." Cost-to-serve is the number every agent company is bleeding on; per-decision cost drops from a metered LLM call to a share of ~$0.002/day per warm isolate, latency from 2–5s to ~4ms.
2. **Compile target of the agent economy (strategic/analyst-facing):** model-neutral by design. The model writes the code anywhere — Claude, GPT, whatever — but it lives and executes on Workers. Model-provider platforms are structurally conflicted about removing inference from the hot path; Cloudflare sells compute, not tokens, and is the structural beneficiary. The position strengthens with agent traffic regardless of which model wins.
3. **Trust (enterprise-facing):** deterministic, versioned, auditable agent behavior. "Why did the agent do that" gets a git-diff answer instead of a shrug. Unique to code vs. cached inference; paired with approval gates, this is the compliance-bound-industry pitch.
4. **The developer metaphor:** *reflexes* — authored by the brain, executed by the spinal cord, no cognition in the hot path. Maps exactly (model authors, runtime executes, milliseconds, deterministic). "Skills" is the alternative but it's contested vocabulary (Anthropic) and undersells the trigger/event half; "Policies" is enterprise-safe but inert.

**Who buys:** agent-platform builders (the Zite class — already hand-rolling this in production at millions of daily executions), SaaS adding per-tenant agent automation (Dynamic Workflows' own named use case), and enterprises with agent fleets needing audit and determinism.

**Competitive frame:** model providers can't credibly build this (conflict of interest with their own inference revenue); Lambda-class serverless can't hit per-user code cardinality economics; sandbox-execution players (E2B/Modal-class) own ephemeral execution but not edge distribution + lifecycle machinery. Cloudflare's moat is isolates plus an existing lifecycle product (WfP) to graduate into.

## The counterargument, stated honestly

Cloudflare's philosophy is composable primitives + libraries as the product; a managed registry adds support surface and a security-review burden for persistent agent-authored code. The rebuttal is precedent: Durable Objects and the Agents SDK both crossed the hand-rolled-pattern → product threshold when the pattern became universal. The claim of `LOADERS-VS-WFP.md` is that the middle crossed it in 2026 — four Cloudflare-shipped shims in three months is the tell.
