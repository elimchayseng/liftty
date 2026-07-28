# Liftty — Technical PM Interview Prep

*Target role: Product Manager, Workers Runtime @ Cloudflare*

Liftty is a good story for this role for one reason: it isn't just *built on* Workers, it **stress-tests a Workers primitive to the point of finding a gap in the platform** — and the plugin system is a prototype of the API that gap implies. Lead with that framing.

---

## 1. The 60–90 second architecture walkthrough

> **Say this out loud, roughly verbatim.** It's ~200 words / ~75 seconds at speaking pace.

"Liftty is an AI weightlifting coach where **each user is a single Durable Object** — that DO owns their program, training history, the live workout session, and their rest-timer alarms. There's no external database; state lives in the DO's hot state plus its **embedded SQLite**. That's deliberate: single-writer per user, no cross-user contention, and it survives redeploys.

The coach is Claude Opus, reached through **Cloudflare AI Gateway** as a custom provider. What's interesting is *how* the model touches the program. Instead of a dozen tool-calls, it runs in **Code Mode** — it writes one JavaScript snippet that executes in a sandbox spun up by the **Dynamic Worker Loader**, and each API call in that snippet RPCs back into the Durable Object. Only the snippet's return value re-enters the context, so it's dramatically cheaper in tokens.

Then the part I'm proudest of: **Liftty Plugins**. The model can author a *persistent* policy — 'if I fail this squat, deload next session' — and we store that JS in the DO and re-run it on every workout event using the same Loader, **with zero tokens and no LLM in the loop**. That's the DO acting as durable storage for runtime-generated code — which the platform doesn't actually offer as a primitive yet."

**If they want you to keep going (the M5 kicker):** "Building that surfaced a real platform gap — I'll come back to it — the Worker Loader's isolate cache is keyed by ID string and shared across every DO in the Worker, so two users with the same plugin name would collide. I namespace the cache key by DO ID to fix it. That bug is basically the argument for why 'persistent modules' should be a first-class Workers primitive."

---

## 2. The primitives, at a glance

| Primitive | Binding | Role |
|---|---|---|
| **Workers** | `main: src/server.ts` | HTTP + WebSocket router, the host runtime |
| **Durable Objects (SQLite backend)** | `LifttyAgent` | One per user; owns all state + alarms |
| **Dynamic Worker Loader** | `LOADER` | Sandbox for Code Mode snippets *and* persistent plugins |
| **AI Gateway** | (URL, not a binding) | Control plane in front of Claude Opus via Heroku inference |
| **Agents SDK** | `agents` npm pkg | `Agent` base class over the DO; state persist + WS broadcast |

Deliberately **not** used: KV, D1, R2, Workers AI, Queues, Workflows, Vectorize, Pages. Know why for each (Section 3).

Two ways the model runs code:
- **Code Mode** (ephemeral) — one JS snippet per turn, thrown away after.
- **Plugins** (persistent) — JS stored in DO SQLite, re-run on events forever, tokenless.

All program writes — coach, session UI, and plugins — funnel through **one validated method, `adjustProgram`**, which clamps magnitudes and writes an audit row to `program_changes`. Single write path = single place to enforce safety.

---

## 3. "Why not X" — defending each choice

### Storage & state

**Why Durable Objects and not a Worker + D1 (or Postgres)?**
The access pattern is single-user, single-writer, read-modify-write on every logged set. A DO gives me a serialized in-memory actor with co-located storage — no connection pool, no read-replica lag, no transaction contention, and the rest-timer is just a DO alarm. D1 would mean a round-trip to a separate SQLite service for state that only one user ever touches, and I'd have to invent the coordination the DO gives me for free.

**Why not KV for the program?**
KV is eventually-consistent and last-write-wins. The program mutates on a hot path (log set → maybe deload) where I need read-your-writes and a serialized writer. KV is built for high-read, edge-cached, tolerant-of-staleness config — the opposite of this.

**Why embedded SQLite in the DO instead of just the DO's key-value storage?**
Hot state (`this.state`) is great for the current program snapshot, but history, the audit trail, plugin events, and token accounting are *relational, queryable, append-with-pruning* workloads. SQLite gives me `ORDER BY`, `LIMIT`, and a real `program_changes` audit table without serializing a growing JSON blob on every write.

**Why not a central DB so you can query across users?**
It's a single-user demo, but the deeper answer is the thesis: per-user isolation is a feature, not a limitation. If I needed cross-user analytics I'd fan-out or ship events to Analytics Engine/a pipeline — I wouldn't compromise the per-user hot path to make aggregation convenient.

### Inference path

**Why AI Gateway + Heroku inference instead of Workers AI?**
Workers AI didn't host the exact frontier model I wanted (Opus), and I wanted the **control-plane** value of AI Gateway independent of the provider — caching, rate-limiting, per-request metadata/analytics, and a single seam to swap providers. AI Gateway as a custom-provider proxy gave me BYO-model *plus* observability. It also let me run the token study (tagging requests via `cf-aig-metadata`).

**Why Code Mode instead of plain tool-calling?**
Tool-calling round-trips every step back through the model — N calls = N inference turns, and every intermediate result burns context tokens. Code Mode lets the model express the whole plan as one snippet; only the return value re-enters context. For multi-step program edits that's a large token/latency win. Tools mode still exists as a one-line fallback (`mode:"tools"`) for when I want the model reasoning visible step-by-step.

**Why not just call the model without streaming?**
The upstream (Heroku's Anthropic endpoint) rejects long non-streaming completions, so I `streamText` and consume server-side. Streaming also gets me the usage chunk for real token accounting — the Gateway logs 0/0 for these, so I read `totalUsage` off the SDK and persist it myself.

### The sandbox & the plugin system (the centerpiece)

**Why the Dynamic Worker Loader and not `eval` / `new Function` / a Node VM?**
Model-authored code is untrusted. The Loader gives me a *real isolate boundary* — I set `globalOutbound: null` (no network), CPU/subrequest limits, and a wall-clock RPC timeout. `eval` runs in my Worker's context with my capabilities; the Loader runs in a separate isolate with capabilities I hand it explicitly. This is a security-model choice, not a convenience one.

**Why let plugins only return proposed changes instead of mutating state directly?**
Blast-radius control. Plugins are **pure functions**: event data in, proposed `ProgramChange[]` out. The DO validates every action against an op-whitelist, an actions-per-event cap, and magnitude clamps in `adjustProgram` — *the plugin is never trusted to mutate anything*. A malicious or buggy plugin can at worst propose a change I reject; it can never corrupt state or break `logSet`.

**Why persist plugins in the DO instead of re-prompting the model each event?**
That's the whole point. Re-prompting means an LLM call — tokens, latency, non-determinism — on every logged set. A stored plugin is deterministic, instant, tokenless, and auditable. The model's job shifts from "be in the loop forever" to "author a policy once." That's runtime-generated code that *persists* — and Workers doesn't expose that as a primitive today, which is the platform argument.

**Why namespace the loader cache key by DO ID? (the bug worth telling)**
The Worker Loader caches isolates by the ID string you pass `get()`, and that cache is **shared across every DO in the Worker**. Two users whose plugins share a slug (`plugin:auto-regulate:v1`) would get a cache *hit* serving the first user's isolate — a cross-tenant leak. Fix: prefix the cache key with the DO ID (`this.ctx.id.toString()`). Stays warm within a user, isolated across users. I'd frame this to Cloudflare as: *the caching semantics of a shared platform primitive need per-tenant keying to be safe by default* — exactly the kind of sharp edge a Runtime PM should own.

### Framework & validation

**Why the Agents SDK instead of a raw Durable Object?**
It gave me state-persistence + WebSocket broadcast + scheduling as batteries-included, so I could spend time on the domain (the training API, the plugin runtime) instead of re-plumbing DO lifecycle. Trade-off: I inherit its routing conventions. Worth it for a prototype; I know exactly what it's doing under me.

**Why hand-written JSON Schema for tools instead of Zod?**
Pragmatic: Zod v4 emits a top-level `$schema` key that the upstream Anthropic endpoint rejects, so I hand-write the tool schemas and strip `$schema` recursively in a fetch shim. Not elegant, but it's a real-world compatibility seam — the kind of integration friction a platform PM should notice and want to file down.

---

## 4. Likely follow-ups & one-liners

- **"How does this scale to millions of users?"** — It already does, structurally: DOs are per-user and independently addressable, so there's no shared bottleneck. Cost/latency scale linearly, not super-linearly. The scaling question becomes *isolate cold-starts for plugins* — which is why the Loader cache matters.
- **"What breaks first?"** — Loader isolate cold-start latency on the plugin hot path under bursty load, and the wall-clock timeout being my only guard against an idle-hanging plugin (CPU limits don't catch a plugin that just `await`s forever).
- **"What would you productize for the platform?"** — A first-class `MODULES.put()/get()` primitive: durable storage for runtime-generated code with per-tenant cache keying, capability scoping, and versioned invalidation built in. Liftty's `plugins.ts` is deliberately two functions to map 1:1 onto that hypothetical API.
- **"What's the biggest risk in the design?"** — Trusting model-authored code. Mitigated by the pure-function contract + DO-side validation, but it's the thing I'd threat-model hardest before this touched real users.
- **"Why one write path?"** — Every mutation source (coach, session chips, plugins) hits `adjustProgram`, so validation, clamping, and audit logging exist in exactly one place. Security and observability both get simpler.

---

## 5. The three sentences to make sure you land

1. **"Each user is a Durable Object with embedded SQLite — single-writer, no external DB, survives redeploys."**
2. **"The model writes code, not tool-calls — ephemeral snippets in Code Mode, and persistent tokenless plugins, both sandboxed by the Dynamic Worker Loader."**
3. **"Building the plugin system surfaced a real platform gap — persistent runtime-generated code with per-tenant isolate caching — which is exactly the primitive a Workers Runtime PM should be thinking about."**
