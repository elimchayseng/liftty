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

## New in M4–M6

### Observed (M4 + M5 shipped, code-verified locally)

- **Worker Loader `load()` is not implemented in local miniflare — `get`-only.** The plan (and `PRODUCT-VISION.md`) specify author-time dry-run via one-shot `LOADER.load()`. In local `vitest`/`wrangler dev`, `LOADER.load` is `undefined`; only `LOADER.get(name, cb)` exists. `createPlugin`'s dry-run therefore uses `get()` with a **unique-per-attempt id** — a guaranteed cache-miss = a fresh one-shot isolate, functionally equivalent to `load()` and portable across both runtimes. A *null-name* `get` also runs but leaks a stray unhandled rejection under vitest; a unique named id does not. Dev/prod API-surface gap worth a demo caveat — re-verify `load()` against prod. (`src/plugins.ts`)
- **vitest-pool-workers + Worker Loader error paths flip the run red even when fully handled.** A failed-to-start dynamic worker (network-blocked plugin, or a syntax-error dry-run) surfaces in workerd as `Uncaught (in promise)` for the microtask window *before* an async `expect().rejects` handler attaches — a false positive that turns exit code to 1. Error-path tests need a **synchronous** try/catch instead of `expect().rejects`. (`test/index.spec.ts` test c)
- **vitest-pool-workers isolated-storage stacking is incompatible with dynamic isolates driven over DO RPC.** With `isolatedStorage:true` (the default), spinning up Worker Loader isolates inside a DO breaks per-test storage stacking ("Isolated storage failed"). Fix: `isolatedStorage:false` and isolate tests by giving each its own DO name instead. (`vitest.config.mts`)
- **Raw Loader DX vs. the `@cloudflare/codemode` SDK wrapper.** M3 used the SDK (`DynamicWorkerExecutor` + `createCodeTool`); M5 plugins use the **raw `LOADER.get` binding**. Rougher: you hand-roll the trusted harness module (plain-object exports aren't RPC-callable, so `HARNESS_SRC` wraps them in a `WorkerEntrypoint` class), manage versioned-id cache invalidation (`plugin:${id}:v${version}`), and pass `globalOutbound`/`limits` on every call. Better: the cache-miss callback gives a **truthful** cold/warm signal the SDK hides — the honest number for `RUNTIME-NOTES.md`.

### Prod-pending (needs Ethan's account/phone — deferred per plan)

- **Hibernation: local vs. prod.** The `onConnect`/`onMessage` WS handshake is not unit-tested (the logic it invokes — `logSet`/`firePlugins` — is covered by M5 tests). Verify on the phone: open `/session` → log a failed set → plan updates with the `· Nms · 0 tokens` receipt → idle mid-rest without burning duration → alarm fires and the socket wakes. Record any local-vs-prod hibernation/alarm difference (WebSockets survive hibernation; in-memory vars don't).
- **Container dev loop.** M6's `.fit` parser runs in a Container. Record Docker requirement, container-enabled deploys, and rebuild latency vs. the isolate hot-reload loop, once built. (Skeleton only — `fit-parser/`.)
- **COROS `.fit` field-mapping design calls.** M6 step 0 inspects a real COROS strength `.fit` export before finalizing the mapping. Record the decisions forced by COROS quirks: rep counts auto-detected; per-set weight possibly absent/user-entered (fall back to prescribed-day weights — `logSet` treats weight as optional); muscle-group tags vary. FIT is an open Garmin standard, but COROS strength sessions have their own field layout, so the mapping to `SetInput[]` is designed from the actual message dump, not Garmin assumptions. (Provisional `_MAPPING_TODO` in `fit-parser/server.py` until a real fixture lands.)

---

## Test-baseline addendum (STEP 0 — resolved, `2b6ae10`)

`npx vitest run` failed to even load: `SyntaxError: 'ai' does not provide an export named 'asSchema'`. **Root cause:** vitest-pool-workers was *externalizing* the `ai` package (letting workerd load its `node_modules` build directly). `ai`'s `asSchema`/`tool` are esbuild getter re-exports (`0 && (module.exports = {...})`) from `@ai-sdk/provider-utils`, which workerd's CJS→ESM interop can't surface as static named exports — and `@cloudflare/codemode/dist/ai.js` does `import { asSchema, tool } from "ai"`. Node and `wrangler deploy` resolve it fine; **test-runtime only.** **Fix:** inline the AI SDK graph so Vite transforms it to clean static ESM before workerd links it — `ssr.noExternal` + `test.server.deps.inline` for `["ai", "@cloudflare/codemode", "@ai-sdk/provider-utils"]` (`vitest.config.mts`). `resolve.conditions` and `deps.optimizer` alone did **not** fix it; inlining is the load-bearing piece. No prod impact. (This supersedes the placeholder — no separate `FRICTION-testbaseline.md` was needed; it was a clean config fix, not a rabbit hole.)
