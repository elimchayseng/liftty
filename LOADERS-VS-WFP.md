# LOADERS-VS-WFP.md — the missing middle of the runtime-code spectrum

**Audience:** VP Product (Developer Platform & AI) + a Workers runtime eng lead.
**Date-stamped:** July 2026. The platform is moving monthly; every dated claim below should be **re-verified the week of the interview** against `developers.cloudflare.com/changelog`.
**Companion doc:** `PRODUCT-VISION.md` sketches the *solution* (an imagined `MODULES` registry). This memo argues the *problem* — why the gap exists, why it matters, and why Cloudflare specifically should own it. Read that one for the API; read this one for the why.

---

## 0. The strategic argument, in order

Lead with the *why*. The gap only matters because of what it blocks — so start there, not at the missing feature.

**(a) The waste is structural.** Production agents re-derive already-made decisions on every invocation. An LLM call is the slowest, most expensive, least deterministic compute primitive we have, and today's agents spend it re-executing decisions that have not changed since the last time they were made. That cost scales with *usage*, not with *value delivered* — it is the line item that kills agent unit economics in production. This is not a tuning problem; it is architectural.

**(b) The fix is compilation — model as compiler, not interpreter.** Split the work by novelty. The model handles novel inputs on the **authoring path** (natural language → policy as code, once). A deterministic runtime handles repeated inputs on the **hot path** (execute the compiled policy forever, no inference). This is not "less AI" — it is inference where it is differentiated and code where it is cheap. Interpreter for novel inputs, JIT-compiled policy for repeated ones.

**(c) Three payoffs, not two.** (1) *Cost-to-serve*: a metered LLM call collapses to a share of a ~$0.002/day warm isolate. (2) *Latency*: 2–5 seconds of inference collapses to ~4ms of execution — three orders of magnitude. (3) *Determinism*: same event → same action → auditable diff. The third payoff is the one production agents cannot get any other way: compliance, debugging, and trust all require it. A cached LLM output gives you none of the three; compiled code gives you all three.

**(d) The gap is the adoption blocker for the correct architecture.** Model-as-compiler only becomes the *default* way agents are built when persistent agent-authored code is a **managed platform feature**. As long as it is a ~200-line hand-rolled pattern, only Zite-class teams do it. As a platform feature, it is how every agent gets built. So the backlog in §7 is not a convenience list — it is the specific set of things standing between the correct agent architecture and its becoming the default one.

**(e) Why Cloudflare specifically.** Cloudflare sells compute, not tokens. Every decision moved from the model to an isolate shifts spend *away from* model providers and *onto* Workers. Model-provider platforms are structurally conflicted about removing inference from the hot path — it is their revenue. Cloudflare is the structural beneficiary. Owning the middle of this spectrum makes Cloudflare the default compile target for the agent economy — a position that *strengthens with agent traffic regardless of which model wins*.

**(f) Liftty is the existence proof.** One app, both paths measured. A token study at the left end of the spectrum (cheaper inference — see `TOKEN-OPTIMIZATION.md`), a plugins system in the middle (zero inference per event), and a container contrast showing the pattern spans runtimes. The receipt strip the user sees after a logged set — **"plugin fired · 4ms · 0 tokens"** — is the entire thesis compressed into one UI element. We built the hand-rolled version end-to-end precisely to find out what the platform feature needs to be.

---

## 1. The spectrum

Runtime-generated code lives on a spectrum defined by **code lifetime**. Two ends are owned Cloudflare products. The middle is owned by nobody.

| | **Ephemeral runtime code** | **Persistent runtime-generated code** | **Deploy-time code** |
|---|---|---|---|
| **Owned by** | Dynamic Workers (`LOADER.load()`), Code Mode | **Nobody — this is the gap** | Workers for Platforms (dispatch namespaces) |
| **Code authored** | At runtime, by a model, per request | At runtime, by a model, **once** | At deploy time, by a developer / tenant pipeline |
| **Code lifetime** | One execution, then discarded | Stored, versioned, re-executed on events indefinitely | Full deployment lifecycle |
| **Model in the loop** | Every request (writes fresh code each time) | Authoring only; **never on the execution path** | Never |
| **Lifecycle provided** | None, by design | **Hand-rolled** (the Facets post is a recipe, not a product) | Storage, versioning, routing, observability, limits — all managed |
| **Supporting shims** | `@cloudflare/codemode` | `get()` isolate cache, DO Facets (per-code *state*), `@cloudflare/shell` (agent *data*), `@cloudflare/dynamic-workflows` (durability), `@cloudflare/worker-bundler` (deps) | Dispatch worker routing, outbound workers, tail workers |

**Code Mode vs. plugins — the distinction is lifetime, not capability.** Both use the same primitive. Code Mode invokes the model on *every request*, writes fresh code each time, executes it once via `load()`, and discards it — the model stays in the hot path, just cheaper per pass (it optimizes the cost *of each inference*). Plugins invoke the model *once*, at authoring; the source is stored and every subsequent event executes it via `get()` with zero inference — the model moves from the hot path to the authoring path. One line: **Code Mode makes the model's decisions cheaper; plugins make already-made decisions free.** The persistence is exactly what forces every row of lifecycle machinery in the "Nobody" column.

---

## 2. The claim (falsifiable, date-stamped)

> **As of July 2026, for code generated at runtime that must persist and re-execute on later events, no Cloudflare product provides managed code storage, versioning/rollback, pre-execution validation, per-code-unit observability, or a graduation path.**

Falsifiable on its face: name the product that ships those five things for runtime-authored persistent code and the claim is dead. Dynamic Workers ships none of them by design (§3a); Workers for Platforms ships all of them but only for the deploy-time ingestion model (§4); the five libraries shipped into the middle each ship *one slice* and none ships the lifecycle (§3b). **Re-verify the week of the interview** — the whole point of the dateline is that a changelog entry could move it.

---

## 3. Evidence

### (a) API design — persistence-as-your-problem is in the interface

The raw Dynamic Workers binding offers two calls: `LOADER.load(code)` (one-shot, uncached) and `LOADER.get(id, callback)` (cached; the callback runs *only on cache miss*). The docs' own canonical example for `get()` loads the code **from your own storage** inside that cache-miss callback. Persistence being the caller's problem is not an oversight — it is designed into the shape of the interface. The primitive hands you an isolate cache and a code-id; where the code *lives* between executions is left entirely to you. (Confirmed against the generated binding types in `worker-configuration.d.ts:3476`: `get(name, getCode)`, `load(code)`, with `globalOutbound: null`, `limits: { cpuMs, subRequests }`, multi-module `modules`, and `env`.)

### (b) Shipping behavior — four shims into the middle in ~3 months

Cloudflare has shipped, in roughly three months, a run of point-solutions that each fill one slice of the middle and none of which is a lifecycle product:

- `@cloudflare/codemode` + `@cloudflare/worker-bundler` + `@cloudflare/shell` (March 2026, alongside the Dynamic Workers open beta)
- **Durable Object Facets** (April 30, 2026 blog post)
- `@cloudflare/dynamic-workflows` (May 1, 2026 changelog)

Each solves exactly one slice — execution, dependency bundling, agent files/data, per-code *state*, durability. None solves lifecycle. **The April 30 Facets post publishes essentially the plugins pattern itself**: it opens with "what if you want an AI to generate *more persistent* code?" and answers with code stored in a DO's storage under a generated `codeId`, replayed into `LOADER.get()`, `globalOutbound: null`. That a first-party post has to *publish this as a hand-rolled recipe* is the strongest possible evidence that it is not yet a product. (Framing note, important: the Facets *post* published the pattern; Facets *themselves* solve per-code **state**, not code lifecycle. "Facets solved this" is false and concedes the gap away — see §5.)

### (c) Demand at scale

Zite runs millions of daily dynamic-worker executions for chat-built apps — a production team already carrying the middle of the spectrum in-house, hand-rolling the storage/versioning/observability glue because there is no managed feature to lean on. Demand for the middle is not hypothetical; it is already being served by teams large enough to afford building it themselves.

### (d) Our build — the six hand-rolled items, with refs into liftty

Building liftty's plugins system end-to-end produced exactly the list of things the platform does not provide. Each maps to real code:

1. **Code storage / source of truth** — a `plugins` table in the DO's embedded SQLite, created in `onStart()` alongside the existing `sessions` table (`src/server.ts:354`). Memo exhibit #1: the code registry the platform doesn't provide.
2. **Versioning + rollback** — versioned isolate ids `plugin:${id}:v${version}`; a version bump is deterministic cache invalidation. Hand-rolled versioning made visible.
3. **Pre-execution validation** — an author-time dry-run via one-shot `LOADER.load()` against a synthetic event before `INSERT`; reject on throw or bad shape. You cannot lint a cached LLM output; you *can* dry-run compiled code.
4. **Per-code-unit observability** — `{plugin, ms, cold, actions}` JSON log lines (feeding `wrangler tail`) plus `last_run`/`last_result` columns, rendered as on-screen receipts.
5. **Quotas / blast-radius controls** — `globalOutbound: null`, `limits: { cpuMs: 50, subRequests: 0 }`, an action cap (≤3 per event), and an op whitelist (`deload`/`setExerciseWeight`). Deny-by-default; a buggy or malicious plugin can at worst propose whitelisted changes, and a throwing plugin is recorded and skipped, never breaking `logSet`.
6. **Graduation path** — *no story at all* for promoting a hot plugin into a real deployed Worker with a full lifecycle. This one isn't hand-rolled; it's simply absent.

The plugin returns a `ProgramChange[]` (the existing discriminated union at `src/training.ts:38`) and never mutates state directly — all writes go through the already-validated `adjustProgram` path. The dispatch site is an **application event** (a WebSocket `log_set` message hits the DO, the DO dispatches to the plugin isolate), *not* an agent tool choice: after authoring, the agent chooses nothing, and no LLM call or context window sits anywhere on that path. These six items are simultaneously what the build produced and the backlog in §7.

---

## 4. Why not runtime WfP upload — right lifecycle, wrong ingestion model

An interviewer will ask: Workers for Platforms already has the whole lifecycle — versioning, observability, limits, routing. Why not just have the agent upload each plugin into a dispatch namespace at runtime? The crisp answer: **WfP has the right lifecycle attached to the wrong ingestion model.** Three concrete reasons, in liftty terms:

1. **Wrong plane.** WfP upload is a call to Cloudflare's account-management API — the same control plane `wrangler deploy` uses. That puts a *deploy-scoped API token inside an agent that executes model-written code* (an agent holding credentials that can deploy account-wide), plus propagation delay before the script is callable. The DO-local pattern keeps the hot path entirely on the data plane: code goes into the DO's own SQLite and runs on the next event, no external authority involved. Rule of thumb: **the hot path should never depend on the management layer.**
2. **Wrong cardinality.** WfP's pricing, dashboard, and management model assume one meaningful script per *tenant*. Plugins are many trivial scripts per *user* — a real product has millions of ~30-line policies. Making each a full deployed Worker is registering a company for every sticky note; the ~$0.002/day isolate economics exist precisely because Dynamic Workers carry no per-script management overhead.
3. **Split trust domain.** Today authoring, storage, and execution all live in one Durable Object — one trust domain. Runtime WfP upload scatters them across a dispatch namespace, the DO, and a dispatch Worker — three moving parts where there was one.

**The honest asymmetry, and the bridge.** The middle is closer to Dynamic Workers in *ingestion* (runtime, data-plane, per-user scale) but closer to WfP in *lifecycle needs* (versioning, observability, limits). The gap product is WfP's lifecycle grafted onto Dynamic Workers' ingestion. That framing also makes the **graduation path** the natural bridge, not a hack: *code born in the middle should be able to retire on the right* — a hot plugin promoted into a real WfP Worker with the full managed lifecycle. Without graduation the middle is a dead end; with it, the middle is the on-ramp to the right end and the spectrum is one continuous story.

---

## 5. Differentiation from `@cloudflare/shell`

A runtime eng lead will probe this line, because `shell` looks adjacent. It is not:

- **`@cloudflare/shell` persists the agent's *files and data*** — a working filesystem for an agent's scratch state.
- **Plugins persist *versioned executable policy with a typed contract*** — code, stored under a version-stamped id, validated at authoring against an enforced entrypoint shape (`onSetLogged(event) -> {actions, note?}`), re-executed deterministically on events.

The difference is data vs. code, and specifically vs. code with a *contract*. `shell` gives an agent a place to keep bytes; the middle needs a place to keep *behavior* — behavior that is dry-run-validated before it runs, capability-restricted, versioned, and observable per unit. Two properties make plugins more than caching, and both land with this audience: the code is **checkable before it runs** (you cannot lint a cached LLM output) and **deterministic and auditable after** (same event → same actions → loggable diff). Neither is anything `shell` sets out to provide.

---

## 6. The counterargument, addressed

**The objection.** Cloudflare's philosophy is composable primitives plus libraries as the product. A managed registry for persistent agent-authored code adds a support surface and a security-review burden. Why not leave the middle as primitives-plus-a-recipe and let teams compose it?

**The rebuttal is precedent.** Durable Objects and the Agents SDK are both cases where Cloudflare took a hand-rolled pattern across the threshold into a product *once the pattern became universal*. DOs productized the "coordinate state at a single point" pattern; the Agents SDK productized the "stateful agent on a DO" pattern that everyone was otherwise re-implementing. The claim here is that the middle of the runtime-code spectrum has crossed the same threshold in 2026 — and the tell is Cloudflare's own shipping cadence: **four shims into the middle in three months, plus a first-party post publishing the hand-rolled recipe.** That is what "the pattern became universal" looks like from the inside.

**The strongest internal evidence of the pull is Dan Lapid's Dynamic Workflows** (`@cloudflare/dynamic-workflows`, May 2026). It is a Cloudflare-shipped library whose *named use case* is per-tenant SaaS business logic authored dynamically — i.e. persistent runtime-generated code needing durability. That the runtime team itself shipped a durability slice for exactly this workload is the pull made concrete: the demand is real enough that the team is already building *pieces* of the answer. The memo's argument is only that the pieces should converge into one lifecycle product.

---

## 7. The backlog — what the product that claims the middle must ship

Whichever product owns the middle, this is its feature set (each item maps 1:1 to something liftty hand-rolls — see `PRODUCT-VISION.md` for the annotated API):

- **Managed `LOADER.put(id, source)`** with **version history + rollback** (replaces the `plugins` table + `plugin:${id}:v${version}` ids + manual version column)
- **Per-id tail / analytics** — invocations, p50/p99, cold rate, error rate (replaces `last_run`/`last_result` + `console.log` JSON lines)
- **Validation hooks** — contract declaration + mandatory author-time dry-run (replaces `HARNESS_SRC` + the manual shape check + the hand-rolled `load()` dry-run)
- **Declarative capability manifests + auto-disable on error rate** (replaces per-call `globalOutbound`/`limits` + the manual action cap/op whitelist; adds a kill switch)
- **Quotas / billing attribution** per module
- **Event / trigger binding** — modules subscribe to DO-emitted events (the tail-worker/queue-consumer pattern applied to agent code) + cron for scheduled modules; removes the last piece of hand-rolled wiring (today the app manually calls the runner from the `log_set` path)
- **Optional human-approval gates** — versions requiring review before activation (enterprise)
- **Graduation** — `wrangler modules promote` → a real Worker in a WfP dispatch namespace (the §4 bridge)

**Where it lives.** A split matching Cloudflare's established primitive→SDK productization arc (the Durable Objects → Agents SDK path exactly): the **primitive in Dynamic Workers** — the registry is mechanically an extension of the Loader, so the `MODULES` binding lives here — and the **DX surface in the Agents SDK** — agent-native tools for authoring and managing modules, so any agent gets the pattern out of the box. WfP is the graduation *target*, not the home.

**AX alongside DX.** When the agent is the author, the lifecycle API's primary consumer is a *model*, not a human — so schemas must be tool-callable and validation errors must be structured for model self-correction (the model rewrites the code and retries `put()`), with docs shipped as llms.txt. Agent experience (AX) becomes a design discipline alongside developer experience (DX), and Cloudflare is already halfway there (docs MCP server, llms.txt on every page).

---

## 8. Adjacent gap categories

The same missing middle recurs across three buyer segments — the point is that this is one abstraction, not a vertical feature:

- **Per-user policy / automation rules** *(consumer — this project)*. Liftty's training policies: millions of ~30-line per-user behaviors that no deploy pipeline can serve, only runtime loading on isolates makes economical. The direct case.
- **Agent skill libraries** *(agent-infra)*. An agent that improves by writing itself reusable functions — the plugins table generalized from "user policies" to "the agent's own accumulated capabilities." Same storage/versioning/validation machinery, different author intent.
- **Per-tenant SaaS business logic** *(enterprise)*. Dynamic Workflows' own named use case: a SaaS platform letting each tenant define automation logic authored at runtime and executed durably on the tenant's events. This is the enterprise face of the same gap — and, per §6, the one the runtime team is already shipping pieces for.

Consumer, agent-infra, enterprise — one missing platform primitive underneath all three.

---

## 9. How this is NOT a rebuild of Durable Object Facets

The sharpest objection a runtime eng lead can raise is: *"Cloudflare already shipped this — Durable Object Facets, April 30. You rebuilt Facets."* The answer has to be airtight, because getting it wrong concedes the entire thesis (see §3b, §6). It is airtight, and here is why.

### 9.1 Facets are a state primitive; this is a code lifecycle layer

Facets give a Durable Object child sub-objects, each with isolated SQLite. They answer exactly one question: *where does dynamically-loaded code's state live* — without touching the parent DO's data. That is the **state plane** of dynamic code, and it is a real, useful primitive.

They answer *none* of the questions this build exists to answer: no code registry, no versioning or rollback, no contract enforcement, no pre-execution validation, no per-module observability, no enable/disable, no failure isolation. Everything liftty's plugins system built *is* that missing list. Facets manage the **state plane**; plugins manage the **code plane**. They sit in different layers of the same stack — complementary, not competitive.

### 9.2 The concrete lifecycle behaviors Facets do not have — with anchors

Each of these is real code in this repo, not a slide. This is the code-plane machinery Facets leave entirely to you:

- **A code registry / source of truth** — a `plugins` table in the DO's own embedded SQLite: `id, name, source, version, enabled, created_at, last_run, last_result` (`src/server.ts:538-547`). Facets give you sub-object storage; they do not give you a *registry of code units*.
- **Versioning → deterministic cache invalidation** — every module runs under a versioned isolate id `plugin:${id}:v${version}` (`src/plugins.ts:274`); a version bump *is* the cache invalidation, by construction (`src/plugins.ts:246`). Facets have no notion of a code version at all.
- **Author-time pre-execution validation** — before a module is ever stored, `createPlugin()` dry-runs the model's source in a throwaway one-shot `LOADER.load()` isolate against a synthetic event and rejects on any throw or bad return shape (`src/plugins.ts:216-237`, dry-run stub at `src/plugins.ts:197-206`). You cannot lint a cached LLM output; you *can* compile-and-shape-check code before it reaches the hot path. Facets validate nothing.
- **A typed contract, enforced** — modules return `ProgramChange[]`, the existing discriminated union (`src/training.ts:38-42`), through an op whitelist `ALLOWED_OPS = {deload, setExerciseWeight}` (`src/plugins.ts:101`) capped at three actions per event (`MAX_ACTIONS_PER_EVENT`, `src/plugins.ts:100`). A buggy or hostile module can at worst *propose* whitelisted changes; it can never write state directly. Facets enforce no contract.
- **Per-module observability / receipts** — `last_run` / `last_result` columns on the row plus a `PluginReceipt` (`{name, version, ms, cold, actionsApplied, changed, error?}`, `src/plugins.ts:78`) emitted per fire, surfaced as an on-screen receipt and a `wrangler tail` JSON line. Facets emit no per-code-unit telemetry.
- **Failure isolation** — a throwing module is recorded and skipped inside `runPlugins()` (`src/plugins.ts:261-263`); `logSet` has already succeeded before the plugin runs, so a broken policy can never break the set. Facets give you isolated *state*, not isolated *failure of the code lifecycle*.
- **Enable / disable** — the `enabled` column gates the hot-path `SELECT`; a module is switched off without deleting its history. Facets have no such switch.

### 9.3 This build mechanically doesn't use Facets at all

Not "chose a different design" — *doesn't touch them*. The modules are **pure functions**: data in (a logged-set event), proposed actions out (`ProgramChange[]`), no state of their own. The registry lives in the **parent DO's own SQLite**, not in any sub-object. There is nowhere in this build a Facet would attach, because nothing dynamically-loaded here holds durable state.

That is also exactly where Facets *become* the right call. The moment a module needs its own durable state — a rolling counter, an accumulated model, a per-module scratch table — the correct design is to **adopt Facets for that state** rather than hand-roll it. That is the plan's stretch item, and it is the cleanest illustration of the layering: Facets are the answer to a question this build has deliberately not yet asked. Complementary, not competitive.

### 9.4 The real overlap is with the blog post's recipe — and that's an asset

The honest overlap is not with the Facets *feature*; it is with the **April 30, 2026 Facets blog post**, which opens with *"what if you want an AI to generate more persistent code?"* and answers with a hand-rolled recipe: store the source in DO storage under a generated id, replay it into `LOADER.get()`, `globalOutbound: null`. That is the plugins pattern — published, by Cloudflare, as a recipe.

This is an asset, not an embarrassment. A first-party post publishing the pattern as a *hand-rolled recipe* is the strongest possible evidence that the pattern is real, wanted, and **not yet a product**. Citing it converts the anxious question *"did I just rebuild X?"* into the confident claim: **Cloudflare published the pattern; I built it end-to-end** — versioned, validated, observable, capability-restricted — *and the glue I had to write is the backlog for the product that should own the middle.*

### 9.5 Honest weaknesses (about the demo, not the argument)

Stated plainly so no one else has to find them:

- **Until Phase 2 lands, every number is fabricated.** One *"is that real?"* in the room collapses credibility. The whole point of the live-events work is to make the receipt ms, cold/warm flag, and ledger *provably* real end-to-end — which is what §PR-TESTING's truthful-numbers gates exist to prove before the artifact is ever shown.
- **The ledger constants are assumptions.** Tokens-per-re-derivation and $/M are estimates; either source the token figure from real usage or label it `est.` Do not present an assumption as a measurement.
- **The persistence claim is invisible in client-state-only viz.** "It survives redeploy" is a strong beat that shows nothing unless it is demonstrable — the `plugin_events` backfill is precisely what makes the persistence visible in the room. Without it, the strongest structural argument is the one the audience can't see.

### The one-liner for the room

> **"Facets answer where dynamic code's *state* lives. Nothing yet answers where the dynamic code *itself* lives — versioned, validated, observable. I built that answer, and the fact that I had to is the product gap."**
