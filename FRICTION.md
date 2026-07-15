# FRICTION.md — build friction log (interview deliverable)

**Date-stamped:** July 2026. This is the running record of every place the platform, its docs, or its SDKs bit back during the liftty build — kept continuously, not reconstructed at the end. The recurring theme is worth stating up front: **fast-moving beta APIs mean the docs and the installed package drift apart within weeks, and some entitlement gates are invisible until you deploy to prod.** Fetching current docs at runtime, and verifying against prod rather than `wrangler dev`, paid off repeatedly below.

Re-verify the specifics the week of the interview — several items reference SDK versions and changelog dates that are still moving.

---

## M0–M3 — shipped and merged (the eight-item log)

1. **Docs drift is real.** The Code Mode SDK was rewritten: `@cloudflare/codemode` v0.1.0 (Feb 2026 changelog) removed the old `experimental_codemode()` / `CodeModeProxy` entirely; the agents-starter template is now Vite+React; the server hook `onStateUpdate` was renamed `onStateChanged`. Fetching current docs at runtime rather than trusting training data is what caught these — two hook renames alone were caught this way.

2. **Custom-provider auth: the upstream key goes in the `Authorization` header, not BYOK.** A *custom* AI Gateway provider does not store the upstream key (the BYOK dropdown is for named providers only). The Worker passes it as `Authorization: Bearer`; `cf-aig-authorization` (Authenticated Gateway) is optional and unused. The first 401 we hit was Heroku rejecting a placeholder key, not a Cloudflare problem — an easy misdiagnosis. (See `src/model.ts`.)

3. **zod v4 → top-level `$schema` rejection.** AI SDK v6 + zod v4 emits a top-level `$schema` key that Heroku's Anthropic endpoint rejects. Fix: define all tool schemas with `jsonSchema()` (hand-written JSON Schema) instead of zod. This lesson recurs in items 6 and 7.

4. **Heroku requires non-empty message content.** The AI SDK emits empty content for tool-only assistant turns, and Anthropic also rejects whitespace-only blocks. Fix: a request shim in `src/model.ts` that substitutes a non-whitespace placeholder on intermediate messages.

5. **Seeding vs. persistence narrative.** An every-wake reseed would mask the very persistence guarantee the demo sells. Fix: seed **once** via a `meta.seed_version` flag so edits persist and persistence is genuinely observable rather than masked by re-seed.

6. **Code Mode SDK drift, again — 0.1.0 → 0.4.2.** `@cloudflare/codemode` moved from the PLAN snapshot's 0.1.0 (Feb 2026) to 0.4.2. The `DynamicWorkerExecutor` + `createCodeTool({ tools, executor })` shape still holds; the package also grew a heavier `createCodemodeRuntime` path (durable executions, approvals, snippets) we didn't need. Auto type-gen handles our `jsonSchema()` tools (it detects the AI SDK wrapper), so no hand-written `types` were needed.

7. **`$schema` rejection returns via the Code Mode tool.** M2's four hand-written tools dodge Heroku's `$schema` rejection, but `createCodeTool`'s generated `codemode` tool builds its own StandardSchema that re-emits a top-level `$schema`. Fix: the `src/model.ts` request shim now strips `$schema` **recursively** from the outgoing body (it's pure JSON-Schema dialect metadata, always safe to drop) — one place, covers any future tool.

8. **Dynamic Worker Loader gates on Workers Paid — and free-tier `wrangler dev` hides it.** `wrangler dev` runs the Worker Loader locally with no plan check, so Code Mode looked fully done before deploy. Only `wrangler deploy` surfaced API error **10195 — "switch to a paid plan"**: the account was on Free (M0–M2 shipped on Free because Workers + DO + SQLite don't require Paid). Lesson: **a binding that works in `wrangler dev` is not proof it's provisioned in prod** — verify the plan/entitlement early. This is the sharpest instance of the "verify against prod, not dev" theme.

---

## New in M4–M6 (to be filled as milestones land)

Seeded from the plan's anticipated friction points; each becomes a full entry with specifics once the milestone ships. **Not yet observed — placeholders.**

- **Hibernation: local vs. prod.** M4 tests DO hibernation by idling the phone mid-rest and watching `wrangler tail` to confirm the alarm still fires and the socket wakes. Record any local-vs-prod difference in hibernation/alarm behavior (WebSockets survive hibernation; in-memory vars don't — confirm this holds identically in both environments).
- **Raw Loader DX vs. the `@cloudflare/codemode` SDK wrapper.** M3 used the SDK wrapper (`DynamicWorkerExecutor` + `createCodeTool`); M5 plugins use the **raw `LOADER.get`/`LOADER.load` binding** directly. Record where the raw binding is rougher than the SDK (manual harness module, RPC-callability of plain-object exports, versioned-id cache management) and where it's better (a *truthful* cold/warm signal from the cache-miss callback that the SDK hides).
- **Container dev loop.** M6's `.fit` parser runs in a Sandbox/Container. Record the local dev-loop friction: Docker requirement, container-enabled deploys, rebuild latency vs. the isolate hot-reload loop.
- **COROS `.fit` field-mapping design calls.** M6 step 0 inspects a real COROS strength-session `.fit` export before designing the parser. Record the field-mapping design decisions forced by COROS's quirks: rep counts auto-detected, per-set weight possibly absent or user-entered (fall back to matching weights from the prescribed program day — `logSet` already treats weight as optional), muscle-group tags varying. FIT is an open Garmin standard but COROS strength sessions have their own field layout, so the mapping to `SetInput[]` is designed from the actual message dump, not from Garmin assumptions.

---

## Test-baseline addendum

*Placeholder:* if the test-baseline fix produces a `FRICTION-testbaseline.md` in the repo root, its content should be folded in here. As of this writing that file does not exist; the test-baseline work may add one friction item (to be merged in when it lands).
