# PR-TESTING.md — product-requirement gates before the room sees it

**Audience:** Ethan, running the FLOW-LIVE-EVENTS build toward a live demo.
**Companion docs:** `liftty-plugins-plan-v2.md` (the build), `LOADERS-VS-WFP.md` §9.5 (the honest weaknesses this checklist exists to close).

## The north-star requirement

**Every number on `/flow` is truthful end-to-end.** The receipt ms is a real measured duration, the cold/warm flag is a real cache state, the ledger reflects real avoided inference, and the persistence beat survives a real redeploy. The single failure mode that collapses the demo is one *"is that real?"* landing on a fabricated number (see `LOADERS-VS-WFP.md` §9.5). This checklist exists to **prove truthfulness before the artifact is shown in a room** — not to feel done, but to be able to answer "yes, that's real" without flinching.

**How to read this doc.** Each item is a **PASS/FAIL assertion with an observable signal**. If you can't point at the signal, it's a FAIL — no vibes, no "looked fine." Checkpoints map to the plan's phases; clear a checkpoint before starting the next phase.

---

## Checkpoint 0 — Pre-flight (local, no worker needed)

Gate before any phase work is considered landable.

- [ ] **Types clean.** Run `npx tsc --noEmit`. **PASS:** exits 0, zero errors printed. **FAIL:** any error line.
- [ ] **Tests green.** Run `npx vitest run`. **PASS:** all suites pass, non-zero test count, exit 0. **FAIL:** any red, or a suite that silently ran 0 tests.
- [ ] **Flow bundle still loads.** Open the current `/flow` bundle in a browser. **PASS:** page renders, every existing button is present and runs its handler (no console error on click). **FAIL:** blank page, missing control, or a thrown error in devtools console.
- [ ] **Visual no-regression.** Put the new `/flow` side-by-side with the current committed file. **PASS:** layout, copy, and controls are unchanged except the intended additions. **FAIL:** any unintended visual drift.

```bash
npx tsc --noEmit && npx vitest run
```

---

## Checkpoint 1 — Phase 1: server events (local via vitest + `wrangler dev`)

The wire contract and the truthful-numbers foundation. Nothing client-facing ships until these pass.

- [ ] **Events are written.** Fire a plugin through the `log_set` path. **PASS:** a `plugin_events` row exists for that fire (query the DO SQLite in a test or via `/db`). **FAIL:** no row.
- [ ] **Events are pruned to 50.** Generate >50 events. **PASS:** the table holds exactly the most recent 50; older rows are gone. **FAIL:** unbounded growth, or pruning to the wrong count.
- [ ] **Backfill on connect.** Open a fresh connection. **PASS:** the `onConnect` backfill payload contains the prior `plugin_events` *and* the current module list. **FAIL:** empty backfill, or modules missing.
- [ ] **Wire shapes match.** Inspect emitted `plugin_fired`, `plugin_created`, `plugin_rejected` messages. **PASS:** each matches the documented wire contract field-for-field (names, types, no extra/missing keys). **FAIL:** any shape drift.
- [ ] **Truthful-numbers gate.** Run `wrangler tail` while firing. **PASS:** the ms value in the tail JSON line **equals** the ms in the corresponding `PluginReceipt` (same measured number, not two independent clocks). **FAIL:** the two disagree — that means one of them is fabricated.

```bash
wrangler dev          # terminal 1
wrangler tail         # terminal 2 — watch the JSON log lines
```

---

## Checkpoint 2 — Phase 2: client live viz (needs a running worker)

This is the checkpoint that retires "every number is fabricated" (`LOADERS-VS-WFP.md` §9.5). Run it against a real worker with `/flow` on desktop and `/session` on a phone.

- [ ] **Hot lane fires for real.** On the phone, log a **FAILED** set. **PASS:** within ~1s the desktop hot lane animates; the receipt shows a **real ms** and a **warm/cold** flag; the ledger increments. **FAIL:** no animation, placeholder ms, or a static ledger.
- [ ] **Author lane fires for real.** Author a policy in `/chat`. **PASS:** the author lane animates and shows a **real dry-run ms** (from the one-shot `load()`). **FAIL:** no animation or a hardcoded number.
- [ ] **Reload rehydrates.** Reload `/flow`. **PASS:** backfilled receipts reappear and the authored-module state is correct (right name, version, enabled). **FAIL:** empty history or stale/wrong module state.
- [ ] **Persistence beat (the load-bearing one).** Redeploy the worker, reload `/flow`. **PASS:** event history remains. **FAIL:** history wiped — the persistence claim is unshowable.
- [ ] **Graceful offline.** Kill the network. **PASS:** the hint reverts to demo text and buttons still run their `· demo` flows (no dead UI). **FAIL:** frozen page, uncaught error, or buttons that do nothing.

---

## Checkpoint 3 — Phase 3: `/db` inspector

The "here's the row it rehydrates from" proof surface. It must be both truthful and safe.

- [ ] **Key gate.** Hit `/db?key=<key>` then `/db` with no key. **PASS:** with key → 200; without key → 404. **FAIL:** 200 without key (leak) or 404 with a valid key (broken).
- [ ] **Row is inspectable.** Open the `plugins` row. **PASS:** the row shows expandable source (the model-authored JS is readable). **FAIL:** source truncated away or unreadable.
- [ ] **Cleanliness strip green.** Pre-demo, check the cleanliness strip. **PASS:** all-green. **FAIL:** any non-green indicator (fix before demo).
- [ ] **Cache-died-row-didn't.** Redeploy, then reload `/db` and `/flow`. **PASS:** the `plugins` row is **unchanged**, while `/flow`'s first receipt is **cold** (isolate cache died, SQLite row survived). **FAIL:** row changed, or first post-redeploy receipt is warm (cache didn't actually die).
- [ ] **SQL box is read-only.** In the SQL box, try `INSERT ...` and a multi-statement `SELECT 1; DROP ...`. **PASS:** both rejected. **FAIL:** either executes.

---

## Checkpoint 4 — Phase 4: reset repeatability

A demo you can only run once is a demo you can't rehearse. Run the full sequence **TWICE** and require identical results.

Sequence per run: `reset(pre-demo)` → author a policy → log 3 sets.

- [ ] **Identical starting program.** **PASS:** both runs begin from the same program state after `reset(pre-demo)`. **FAIL:** run 2 starts from a different program.
- [ ] **Receipts start at set #1.** **PASS:** both runs' receipt streams begin at set #1 (no carryover from the prior run). **FAIL:** run 2 shows leftover receipts.
- [ ] **Cold-then-warm each time.** **PASS:** in both runs the first fire is **cold**, subsequent fires **warm**. **FAIL:** first fire warm (stale isolate survived the reset).
- [ ] **Ledger matches.** **PASS:** the ledger totals match across the two runs for the same set count. **FAIL:** divergent totals.
- [ ] **Backup written.** **PASS:** a `demo_backups` row exists per `reset`. **FAIL:** no backup row.
- [ ] **Restore works.** Run `restoreBackup`. **PASS:** prior state comes back intact. **FAIL:** partial or failed restore.

---

## Demo dry-run script — the exact click-path for the room

Rehearse this end-to-end until it's muscle memory. The closing line is the payload.

1. **`/flow`** — watch a set fire. **Point at:** the receipt says **warm**.
2. **`/db`** — open the `plugins` row. **Say:** "here's the row it rehydrates from."
3. **Redeploy** the worker.
4. **`/flow`** — log a set again. **Point at:** the first receipt comes back **cold** (the isolate cache died on redeploy).
5. **`/db`** — same row. **Point at:** the row is **unchanged**.

> **Closing line: "Cache died, row didn't."**

That single contrast — cold receipt, unchanged row — is the persistence thesis made visible in ten seconds. If any step above can't be demonstrated live, it isn't ready for the room.
