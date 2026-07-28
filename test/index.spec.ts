import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getAgentByName } from "agents";
import { TRAINING_PLAN } from "../fixtures";
import { migrateActuals } from "../src/server";
import { liftBrief, topLiftBrief, summarizeSets, sessionStats } from "../src/lifts";
import { buildTrainingTools } from "../src/training";

// Grab a typed RPC handle to a named LifttyAgent DO (its own per-name SQLite DB → test isolation).
// `getAgentByName` wakes the DO and routes exactly like production, so onStart() (table creation +
// seed) has run by the time the first awaited method resolves.
async function agent(name: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await getAgentByName((env as any).LifttyAgent, name)) as any;
}

// M0 smoke test: the Worker boots and /plan is reachable. The chat endpoint needs
// live AI Gateway creds (Phase 0), so it's not asserted here.
describe("liftty worker (M0)", () => {
	it("serves the /plan placeholder", async () => {
		const response = await SELF.fetch("https://example.com/plan");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("liftty");
	});

	it("404s unknown routes", async () => {
		const response = await SELF.fetch("https://example.com/nope");
		expect(response.status).toBe(404);
	});
});

// design-refresh: the new landing route at "/" (shared header + wordmark + entry rows).
describe("liftty landing (design-refresh)", () => {
	it("serves the landing page at / with the wordmark and entry rows", async () => {
		const response = await SELF.fetch("https://example.com/");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('class="wordmark"');
		expect(html).toContain("liftty");
		// The four entry rows link into the app.
		expect(html).toContain('href="/plan"');
		expect(html).toContain('href="/session"');
		expect(html).toContain('href="/chat"');
		expect(html).toContain('href="/flow"');
	});
});

// M4: the live workout session page renders and wires a raw WS to the agent.
describe("liftty /session (M4)", () => {
	it("serves the /session page with the live-session markup", async () => {
		const response = await SELF.fetch("https://example.com/session");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("liftty");
		expect(html).toContain("session");
		// The page must open a raw WS to the agent and speak the log_set protocol.
		expect(html).toContain("/agents/liftty-agent/me");
		expect(html).toContain("log_set");
		expect(html).toContain("receipts");
		// design-refresh: the configurable rest timer — editable chip + the set_rest frame it sends.
		expect(html).toContain("set_rest");
		expect(html).toContain('id="restchip"');
	});
});

// design-refresh: the configurable rest timer is a real, persisted setting on the agent.
describe("liftty rest config (design-refresh)", () => {
	it("defaults to 60s and setRestSeconds persists a clamped value", async () => {
		const a = await agent("rest-config");
		// Fresh DO seeds the 60s default.
		expect((await a.dumpState()).restSeconds).toBe(60);
		// Setting it clamps to 5–600 and persists.
		expect((await a.setRestSeconds({ seconds: 90 })).restSeconds).toBe(90);
		expect((await a.setRestSeconds({ seconds: 5000 })).restSeconds).toBe(600);
		expect((await a.setRestSeconds({ seconds: 1 })).restSeconds).toBe(5);
		// A fresh handle to the same DO reads the persisted value from durable state.
		const b = await agent("rest-config");
		expect((await b.dumpState()).restSeconds).toBe(5);
	});
});

// FLOW-LIVE-EVENTS: /flow page, plugin_events persistence, and the onConnect backfill.
const AUTO_REGULATE_SRC = `export default {
	onSetLogged(event) {
		if (event.failed && event.set.exercise.toLowerCase().includes("front squat")) {
			return { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 }], note: "cut after miss" };
		}
		return { actions: [] };
	}
}`;

// Open a raw WS to a named DO (same route /session + /flow use), collect the plugin_events_backfill.
async function collectBackfill(name: string): Promise<{ events: Array<Record<string, unknown>>; modules: Array<Record<string, unknown>> }> {
	const resp = await SELF.fetch(`https://example.com/agents/liftty-agent/${name}`, { headers: { Upgrade: "websocket" } });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ws = (resp as any).webSocket as WebSocket | null;
	if (!ws) throw new Error("no webSocket on upgrade response");
	ws.accept();
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no backfill received")), 5000);
		ws.addEventListener("message", (e: MessageEvent) => {
			let msg: { type?: string };
			try {
				msg = JSON.parse(typeof e.data === "string" ? e.data : "");
			} catch {
				return;
			}
			if (msg && msg.type === "plugin_events_backfill") {
				clearTimeout(timer);
				resolve(msg as never);
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			}
		});
	});
}

describe("liftty /flow live events (FLOW-LIVE-EVENTS)", () => {
	it("serves the /flow page as text/html", async () => {
		const response = await SELF.fetch("https://example.com/flow");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	it("records plugin_created + plugin_fired to the event buffer", async () => {
		const a = await agent("flow-events");
		await a.reseed();
		await a.createPlugin({ name: "auto-regulate", source: AUTO_REGULATE_SRC });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const snap = await a.getDbSnapshot();
		const evTable = snap.tables.find((t: { name: string }) => t.name === "plugin_events");
		const types = evTable.rows.map((r: { type: string }) => r.type);
		expect(types).toContain("plugin_created");
		expect(types).toContain("plugin_fired");
	});

	it("prunes the event buffer to <= 50 rows", async () => {
		const a = await agent("flow-prune");
		await a.reseed();
		await a.createPlugin({ name: "noop", source: `export default { onSetLogged() { return { actions: [] }; } }` });
		// 60 fires → 60 plugin_fired + 1 plugin_created = 61 events, pruned to newest 50.
		for (let i = 0; i < 60; i++) {
			await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: false });
		}
		const snap = await a.getDbSnapshot();
		const evTable = snap.tables.find((t: { name: string }) => t.name === "plugin_events");
		expect(evTable.rowCount).toBeLessThanOrEqual(50);
	});

	it("backfills the newest events + module registry on connect (oldest-first)", async () => {
		const a = await agent("flow-backfill");
		await a.reseed();
		await a.createPlugin({ name: "auto-regulate", source: AUTO_REGULATE_SRC });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const backfill = await collectBackfill("flow-backfill");
		expect(Array.isArray(backfill.events)).toBe(true);
		const evTypes = backfill.events.map((e) => e.type);
		expect(evTypes).toContain("plugin_created");
		expect(evTypes).toContain("plugin_fired");
		// A plugin_fired carries the pinned contract fields.
		const fired = backfill.events.find((e) => e.type === "plugin_fired") as Record<string, unknown>;
		expect(fired).toBeTruthy();
		expect(typeof fired.ms).toBe("number");
		expect(typeof fired.version).toBe("number");
		expect(typeof fired.setNumber).toBe("number");
		expect(typeof fired.at).toBe("string");
		expect(typeof fired.actionsApplied).toBe("number");
		// Module registry present.
		expect(backfill.modules.some((m) => m.name === "auto-regulate")).toBe(true);
	});
});

// M5: Liftty Plugins — persistent, model-authored code executed via the raw Worker Loader.
// Each test uses a distinct DO name so its plugins/state don't leak into the others.
describe("liftty plugins (M5)", () => {
	// (a) A plugin persists in the DO's SQLite and fires on a logged-set event, applying its actions
	// through the validated adjustProgram path. A fresh handle to the same DO name reads it from
	// durable storage (not the caller's memory) — the redeploy-survival property, minus the eviction.
	it("persists a plugin and fires it on a logged set", async () => {
		const a = await agent("m5-persist");
		await a.reseed(); // pristine program: Front Squat opener 125

		const source = `export default {
			onSetLogged(event) {
				if (event.failed && event.set.exercise.toLowerCase().includes("front squat")) {
					return { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 }], note: "cut after miss" };
				}
				return { actions: [] };
			}
		}`;
		const created = await a.createPlugin({ name: "auto-regulate", source });
		expect(created.version).toBe(1);

		// A separate handle to the same durable object sees the stored plugin.
		const b = await agent("m5-persist");
		const list = await b.listPlugins();
		expect(list.some((p: { id: string }) => p.id === created.id)).toBe(true);

		// Fire the event (the WS log_set path does this) — no model, no tokens.
		await b.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const prog = await b.getProgram();
		const fs = prog.days[0].lifts.find((l: { exercise: string }) => l.exercise === "Front Squat");
		expect(fs.weight).toBe(100); // the persisted policy applied its change deterministically

		// Bookkeeping recorded a successful, zero-token run.
		const after = await b.listPlugins();
		const row = after.find((p: { id: string }) => p.id === created.id);
		const res = JSON.parse(row.last_result);
		expect(res.ok).toBe(true);
		expect(res.actions).toBe(1);
	});

	// (b) A plugin that calls fetch fails under globalOutbound:null; the error is recorded in
	// last_result and logSet is unaffected (firePlugins/runPlugins swallow it).
	it("records a network-calling plugin's failure and never breaks logSet", async () => {
		const a = await agent("m5-network");
		await a.reseed();

		// fetch only on failure → passes the dry-run (synthetic event failed:false) → gets stored.
		const source = `export default {
			onSetLogged(event) {
				if (event.failed) { return fetch("https://example.com").then(() => ({ actions: [] })); }
				return { actions: [] };
			}
		}`;
		const created = await a.createPlugin({ name: "phone-home", source });

		// logSet succeeds independently of the plugin.
		const logged = await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		expect(logged.activeSets).toBeGreaterThan(0);

		// Firing triggers the fetch → throws under globalOutbound:null → recorded, not propagated.
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const row = (await a.listPlugins()).find((p: { id: string }) => p.id === created.id);
		const res = JSON.parse(row.last_result);
		expect(res.ok).toBe(false);
		expect(typeof res.error).toBe("string");

		// logSet's write is intact — the DO is healthy.
		const dump = await a.dumpState();
		expect(dump.activeLoggedSets).toBeGreaterThan(0);
	});

	// (c) The author-time dry-run rejects a plugin that won't compile.
	// (Manual try/catch, not expect().rejects: the DO-RPC rejection for a failed-to-start dynamic
	// worker is reported by workerd as "uncaught (in promise)" for the microtask window before
	// expect's async handler attaches, which vitest-pool-workers flags as an unhandled error. A
	// synchronous catch around the await handles it immediately and keeps the run clean.)
	it("rejects a syntax-error plugin at dry-run", async () => {
		const a = await agent("m5-dryrun");
		let error: unknown;
		try {
			await a.createPlugin({ name: "broken", source: "export default { onSetLogged(event) { return { actions: [ } } }" });
		} catch (e) {
			error = e;
		}
		expect(error).toBeTruthy();
		expect(String((error as Error).message)).toContain("dry-run failed");
		// Nothing was stored.
		const list = await a.listPlugins();
		expect(list.some((p: { name: string }) => p.name === "broken")).toBe(false);
	});

	// (d0) Cache isolation: two DOs whose plugins slug to the SAME id at the SAME version must each run
	// their OWN source. The loader `get()` cache is keyed by id string alone and shared across all DOs,
	// so the key is namespaced by DO id — otherwise the second firing is a cache hit on the first DO's
	// isolate and silently runs the wrong user's code. (Regression: pre-fix, fsB would be 111.)
	it("isolates the loader cache per DO for a shared plugin slug", async () => {
		const a = await agent("ns-collide-a");
		const b = await agent("ns-collide-b");
		await a.reseed();
		await b.reseed();
		const mk = (w: number) =>
			`export default { onSetLogged(e) { return e.failed ? { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: ${w} }] } : { actions: [] } } }`;
		// Same name → same slug "shared" → same version 1 → identical un-namespaced key.
		await a.createPlugin({ name: "shared", source: mk(111) });
		await b.createPlugin({ name: "shared", source: mk(222) });
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });
		await b.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });
		const fsOf = async (h: Awaited<ReturnType<typeof agent>>) =>
			(await h.getProgram()).days[0].lifts.find((l: { exercise: string }) => l.exercise === "Front Squat").weight;
		expect(await fsOf(a)).toBe(111);
		expect(await fsOf(b)).toBe(222); // each DO ran its own isolate, not a shared cached one
	});

	// (d) Blast radius: non-whitelisted ops are dropped and no more than 3 actions apply per event.
	it("enforces the op whitelist and the 3-action cap", async () => {
		const a = await agent("m5-cap");
		await a.reseed();

		const source = `export default {
			onSetLogged() {
				return { actions: [
					{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 },
					{ op: "setExerciseWeight", exercise: "Incline Bench", weight: 80 },
					{ op: "advanceWeek" },
					{ op: "setPhase", phase: "hacked" },
					{ op: "setExerciseWeight", exercise: "Hang Clean", weight: 90 },
					{ op: "setExerciseWeight", exercise: "Barbell Row", weight: 70 }
				] };
			}
		}`;
		await a.createPlugin({ name: "greedy", source });
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const prog = await a.getProgram();
		// advanceWeek dropped (not whitelisted) → week unchanged.
		expect(prog.weekIndex).toBe(1);
		// setPhase dropped (not whitelisted) → phase not "hacked".
		expect(prog.phase).not.toContain("hacked");
		// First 3 whitelisted setExerciseWeight ops applied…
		const weightOf = (name: string) => {
			for (const d of prog.days) for (const l of d.lifts) if (l.exercise === name) return l.weight;
			return undefined;
		};
		expect(weightOf("Front Squat")).toBe(100);
		expect(weightOf("Incline Bench")).toBe(80);
		expect(weightOf("Hang Clean")).toBe(90);
		// …the 4th whitelisted op (Barbell Row) is beyond the cap → untouched (seed 95).
		expect(weightOf("Barbell Row")).toBe(95);
	});
});

// FLOW-LIVE-EVENTS: /db read-only explorer + repeatable demo reset. DB_KEY comes from the vitest
// miniflare binding (vitest.config.mts), not a committed wrangler var — keep this constant in sync.
describe("liftty /db explorer + demo reset (FLOW-LIVE-EVENTS)", () => {
	const KEY = "test-db-key";

	it("gates /db on the key (404 without / wrong, 200 with)", async () => {
		expect((await SELF.fetch("https://example.com/db")).status).toBe(404);
		expect((await SELF.fetch("https://example.com/db?key=wrong")).status).toBe(404);
		const ok = await SELF.fetch("https://example.com/db?key=" + KEY);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("text/html");
	});

	it("serves a shaped read-only snapshot at /db.json (404 without key)", async () => {
		expect((await SELF.fetch("https://example.com/db.json")).status).toBe(404);
		const res = await SELF.fetch("https://example.com/db.json?key=" + KEY);
		expect(res.status).toBe(200);
		const snap = (await res.json()) as { generatedAt: string; tables: Array<{ name: string; rowCount: number; columns: string[] }> };
		expect(typeof snap.generatedAt).toBe("string");
		expect(Array.isArray(snap.tables)).toBe(true);
		expect(snap.tables.some((t) => t.name === "plugins")).toBe(true);
		expect(snap.tables.some((t) => t.name === "sessions")).toBe(true);
	});

	it("runReadOnlyQuery allows SELECT/PRAGMA and rejects writes + multi-statement", async () => {
		const a = await agent("db-query");
		await a.reseed();
		const ok = await a.runReadOnlyQuery("SELECT COUNT(*) AS n FROM sessions");
		expect(ok.error).toBeUndefined();
		expect(ok.rows.length).toBe(1);
		expect((await a.runReadOnlyQuery("INSERT INTO sessions (id,date,status) VALUES ('x','y','z')")).error).toBeTruthy();
		expect((await a.runReadOnlyQuery("SELECT 1; SELECT 2")).error).toBeTruthy();
		// A single trailing semicolon is allowed.
		expect((await a.runReadOnlyQuery("SELECT 1 AS one;")).error).toBeUndefined();
	});

	it("resetDemo (pre-demo) is idempotent and reports a clean slate", async () => {
		const a = await agent("reset-idem");
		await a.createPlugin({ name: "auto-regulate", source: AUTO_REGULATE_SRC });
		const r1 = await a.resetDemo({ profile: "pre-demo" });
		const r2 = await a.resetDemo({ profile: "pre-demo" });
		expect(r1.ok).toBe(true);
		expect(r1.modules).toBe(0);
		expect(r1.events).toBe(0);
		expect(r2).toEqual(r1); // twice → identical assertion report
	});

	it("post-author reset installs exactly one enabled module", async () => {
		const a = await agent("reset-author");
		const r = await a.resetDemo({ profile: "post-author" });
		expect(r.ok).toBe(true);
		expect(r.modules).toBe(1);
		const list = await a.listPlugins();
		expect(list.length).toBe(1);
		expect(list[0].name).toBe("auto-regulate");
		expect(list[0].enabled).toBe(true);
	});

	it("backs up before wipe and restoreBackup round-trips", async () => {
		const a = await agent("reset-backup");
		await a.reseed();
		await a.createPlugin({ name: "auto-regulate", source: AUTO_REGULATE_SRC });
		expect((await a.listPlugins()).length).toBe(1);

		await a.resetDemo({ profile: "pre-demo" });
		expect((await a.listPlugins()).length).toBe(0); // wiped

		const backups = await a.listBackups();
		expect(backups.length).toBeGreaterThanOrEqual(1); // backup written BEFORE the wipe

		const restored = await a.restoreBackup(backups[0].id);
		expect(restored.ok).toBe(true);
		expect((await a.listPlugins()).some((p: { name: string }) => p.name === "auto-regulate")).toBe(true);
	});

	it("cancels armed restOver schedules on reset (no stale timer mid-demo)", async () => {
		const a = await agent("reset-sched");
		await a.reseed();
		await a.schedule(600, "restOver", { exercise: "Front Squat" });
		expect((await a.listSchedules()).length).toBeGreaterThanOrEqual(1);
		await a.resetDemo({ profile: "pre-demo" });
		expect((await a.listSchedules()).length).toBe(0);
	});

	it("gates /reset-demo on the key + method", async () => {
		expect((await SELF.fetch("https://example.com/reset-demo", { method: "POST" })).status).toBe(404);
		expect((await SELF.fetch("https://example.com/reset-demo?key=" + KEY)).status).toBe(405);
	});
});

describe("liftty program scheme edits (coach sets/reps)", () => {
	// The coach can now change a sets×reps scheme, not just weight/deload — via the new
	// setExerciseScheme op on the single validated adjustProgram write path.
	it("changes sets and reps for matching lifts and reports them as changed", async () => {
		const a = await agent("scheme-edit");
		await a.reseed(); // pristine: Pull-ups 4×6
		const res = await a.adjustProgram({ op: "setExerciseScheme", exercise: "Pull-ups", sets: 3, reps: 10 });
		expect(res.changed).toContain("Pull-ups");
		const pull = (await a.getProgram()).days.flatMap((d: { lifts: unknown[] }) => d.lifts).find((l: { exercise: string }) => l.exercise === "Pull-ups");
		expect(pull.sets).toBe(3);
		expect(pull.reps).toBe(10);
	});

	// design-refresh: the /session chip path passes exact:true so editing one lift never rewrites a
	// name-substring sibling ("Front Squat" must not touch "Pause Front Squat (2s)").
	it("exact:true matches only the named lift, not substring siblings", async () => {
		const a = await agent("scheme-exact");
		await a.reseed(); // Day A has "Front Squat" (4×8) and "Pause Front Squat (2s)" (3×5)
		const res = await a.adjustProgram({ op: "setExerciseScheme", exercise: "Front Squat", sets: 4, reps: 5, exact: true });
		expect(res.changed).toContain("Front Squat");
		expect(res.changed).not.toContain("Pause Front Squat (2s)");
		const dayA = (await a.getProgram()).days[0].lifts;
		const fs = dayA.find((l: { exercise: string }) => l.exercise === "Front Squat");
		const pause = dayA.find((l: { exercise: string }) => l.exercise === "Pause Front Squat (2s)");
		expect([fs.sets, fs.reps]).toEqual([4, 5]);
		expect([pause.sets, pause.reps]).toEqual([3, 5]); // untouched
	});

	// design-refresh: a non-finite scheme value (crafted WS frame → NaN) is skipped, never written.
	it("skips a non-finite sets/reps instead of persisting NaN", async () => {
		const a = await agent("scheme-nan");
		await a.reseed();
		const res = await a.adjustProgram({ op: "setExerciseScheme", exercise: "Pull-ups", sets: NaN as unknown as number });
		expect(res.changed).not.toContain("Pull-ups");
		const pull = (await a.getProgram()).days.flatMap((d: { lifts: unknown[] }) => d.lifts).find((l: { exercise: string }) => l.exercise === "Pull-ups");
		expect(Number.isFinite(pull.sets)).toBe(true);
		expect(pull.sets).toBe(4); // pristine, unchanged
	});

	it("clamps out-of-range values and reports no change when already at target", async () => {
		const a = await agent("scheme-clamp");
		await a.reseed();
		const r1 = await a.adjustProgram({ op: "setExerciseScheme", exercise: "Pull-ups", sets: 999 });
		expect(r1.changed).toContain("Pull-ups");
		const pull = (await a.getProgram()).days.flatMap((d: { lifts: unknown[] }) => d.lifts).find((l: { exercise: string }) => l.exercise === "Pull-ups");
		expect(pull.sets).toBe(20); // clamped 1–20
		// re-applying the same clamped value is a no-op: nothing "changed"
		const r2 = await a.adjustProgram({ op: "setExerciseScheme", exercise: "Pull-ups", sets: 20 });
		expect(r2.changed).not.toContain("Pull-ups");
	});
});

describe("liftty plan change tracking (audit trail)", () => {
	// Every program mutation from the single validated adjustProgram write path lands on the
	// program_changes timeline, with before→after deltas + provenance (source) + optional human reason.
	it("records a coach change with source + reason + before→after delta", async () => {
		const a = await agent("chg-coach");
		await a.reseed(); // Front Squat opener 125
		const res = await a.adjustProgram({ op: "setExerciseWeight", exercise: "Front Squat", weight: 135 }, { source: "coach", reason: "felt easy last session" });
		expect(res.changed).toContain("Front Squat");

		const changes = await a.getProgramChanges(10);
		expect(changes.length).toBeGreaterThan(0);
		const top = changes[0];
		expect(top.op).toBe("setExerciseWeight");
		expect(top.source).toBe("coach");
		expect(top.reason).toBe("felt easy last session");
		const fsDelta = top.detail.find((d: { exercise: string | null }) => d.exercise === "Front Squat");
		expect(fsDelta.before).toBe(125);
		expect(fsDelta.after).toBe(135);
	});

	// A no-op change (already at target) writes NO audit row — the timeline only holds real moves.
	it("does not record a change when nothing actually moved", async () => {
		const a = await agent("chg-noop");
		await a.reseed();
		await a.adjustProgram({ op: "setExerciseScheme", exercise: "Pull-ups", sets: 4, reps: 6 }); // already 4×6
		const changes = await a.getProgramChanges(10);
		expect(changes.length).toBe(0);
	});

	// A fired plugin's change is attributed to `plugin:<name>` and carries the plugin's note as reason.
	it("attributes a plugin's change to plugin:<name> and carries its note as reason", async () => {
		const a = await agent("chg-plugin");
		await a.reseed();
		// Reuses the "auto-regulate" slug that other tests also use — safe because the loader cache key
		// is now DO-namespaced (this DO runs ITS OWN source, note "cut 20% after a miss", not a sibling
		// test's cached isolate). Before the namespace fix this returned the other test's note.
		const source = `export default {
			onSetLogged(event) {
				if (event.failed) return { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 }], note: "cut 20% after a miss" };
				return { actions: [] };
			}
		}`;
		await a.createPlugin({ name: "auto-regulate", source });
		await a.firePlugins({ set: { exercise: "Front Squat", reps: 5, weight: 125 }, failed: true });

		const changes = await a.getProgramChanges(10);
		const pluginChange = changes.find((c: { source: string }) => c.source === "plugin:auto-regulate");
		expect(pluginChange).toBeTruthy();
		expect(pluginChange.reason).toBe("cut 20% after a miss");
	});

	// End-to-end: a recorded change renders in the /plan "plan changes" section (getPlanData → renderPlan).
	it("renders the change in the /plan page", async () => {
		const a = await agent("me"); // /plan reads the singleton "me" DO
		await a.reseed();
		// 105 ≠ the week-1 seed (100) — a same-value change would be a no-op and record nothing.
		await a.adjustProgram({ op: "setExerciseWeight", exercise: "Incline Bench", weight: 105 }, { source: "coach", reason: "form dialed in" });
		const res = await SELF.fetch("https://example.com/plan");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("plan changes");
		expect(html).toContain("form dialed in");
	});

	// The audit trail is surfaced as a detailed table in the /db snapshot.
	it("exposes program_changes in the /db snapshot", async () => {
		const a = await agent("chg-db");
		await a.reseed();
		await a.adjustProgram({ op: "advanceWeek" }, { source: "coach", reason: "week done" });
		const snap = await a.getDbSnapshot();
		const pc = snap.tables.find((t: { name: string }) => t.name === "program_changes");
		expect(pc).toBeTruthy();
		expect(pc.rowCount).toBe(1);
		expect(pc.rows[0].source).toBe("coach");
	});
});

describe("liftty session finalize (live workout → history)", () => {
	// The Finish button (session_complete) persists the active session's logged sets into the sessions
	// table, so getHistory() (and every plugin's recentHistory) reflects real work, not just the seed.
	it("finalizeSession writes logged sets into history and clears the active session", async () => {
		const a = await agent("fin-basic");
		await a.reseed();
		await a.logSet({ exercise: "Front Squat", reps: 8, weight: 130 });
		await a.logSet({ exercise: "Front Squat", reps: 7, weight: 130 });
		await a.logSet({ exercise: "Romanian Deadlift", reps: 8, weight: 120 });

		const res = await a.finalizeSession();
		expect(res.ok).toBe(true);
		expect(res.sets).toBe(3);

		// The active session is cleared…
		const dump = await a.dumpState();
		expect(dump.activeLoggedSets).toBe(0);

		// …and the workout is now durable history (newest first), with a rolled-up summary.
		const hist = await a.getHistory("front squat", 5);
		const live = hist.find((h: { id: string }) => h.id.startsWith("live-"));
		expect(live).toBeTruthy();
		expect(live.summary).toContain("Front Squat 2×");
		expect(live.summary).toContain("Romanian Deadlift 1×");
	});

	// An empty Finish (no sets logged) stores nothing but still clears the session.
	it("finalizeSession discards a session with no logged sets", async () => {
		const a = await agent("fin-empty");
		await a.reseed();
		const before = (await a.getHistory(undefined, 200)).length;
		// Open an active session with zero sets by connecting is WS-only; simulate via logSet then finalize twice.
		const res = await a.finalizeSession(); // no active session at all
		expect(res.ok).toBe(false);
		const after = (await a.getHistory(undefined, 200)).length;
		expect(after).toBe(before); // nothing added
	});
});

describe("liftty multi-week training plan (MULTI-WEEK-PLAN)", () => {
	// (a) Fixture shape guard: the hand-converted training-plan.json is validated here instead of by a
	// CSV parser — every structural invariant the app relies on (rotation by focus, name continuity,
	// finite loads, addedWeight only on bodyweight lifts) is asserted against the committed data.
	it("fixture: 8 weeks, each with the A/B/C days, valid lifts, and consistent names", () => {
		expect(TRAINING_PLAN.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(TRAINING_PLAN.weeks[7].label).toBe("RETEST");
		for (const w of TRAINING_PLAN.weeks) {
			expect(w.days.map((d) => d.day)).toEqual(["Day A", "Day B", "Day C"]);
			// Focus names are load-bearing (todayIndex rotation + WS day matching) — identical every week.
			expect(w.days.map((d) => d.focus)).toEqual(["Front Squat", "Incline Bench", "Hang Clean"]);
			for (const d of w.days) {
				expect(d.lifts.length).toBeGreaterThan(0);
				for (const l of d.lifts) {
					expect(Number.isInteger(l.sets) && l.sets >= 1).toBe(true);
					expect(Number.isInteger(l.reps) && l.reps >= 0).toBe(true);
					if (l.kind === "rounds") expect(l.reps).toBe(0);
					else expect(l.reps).toBeGreaterThanOrEqual(1);
					if (l.weight != null) expect(Number.isFinite(l.weight) && l.weight > 0).toBe(true);
					// addedWeight is exclusively the BW+X shape — never alongside a bar weight.
					if (l.addedWeight != null) {
						expect(l.weight).toBeUndefined();
						expect(Number.isFinite(l.addedWeight) && l.addedWeight > 0).toBe(true);
					}
				}
			}
		}
	});

	// (b) advanceWeek loads the next plan week's prescriptions into the live program and records
	// composite before→after deltas on the audit trail.
	it("advanceWeek loads week 2 prescriptions and records per-lift deltas", async () => {
		const a = await agent("plan-adv");
		await a.reseed(); // week 1: FS 4×8 @ 125, RDL 4×8 @ 115
		const res = await a.adjustProgram({ op: "advanceWeek" }, { source: "coach", reason: "week 1 done" });
		expect(res.changed).toContain("Front Squat");

		const prog = await a.getProgram();
		expect(prog.weekIndex).toBe(2);
		const dayA = prog.days[0].lifts;
		expect(dayA.find((l: { exercise: string }) => l.exercise === "Front Squat").weight).toBe(130);
		expect(dayA.find((l: { exercise: string }) => l.exercise === "Romanian Deadlift").weight).toBe(125);

		const top = (await a.getProgramChanges(5))[0];
		expect(top.op).toBe("advanceWeek");
		expect(top.summary).toContain("plan loaded");
		const fsDelta = top.detail.find((d: { exercise: string | null }) => d.exercise === "Front Squat");
		expect(fsDelta.before).toBe("4×8 @ 125");
		expect(fsDelta.after).toBe("4×8 @ 130");
	});

	// (c) An in-week override is overwritten by the plan on advance — and the audit row shows the
	// override as `before`, so the overwrite is legible, never silent.
	it("advanceWeek overwrites an in-week override and shows it in the delta", async () => {
		const a = await agent("plan-override");
		await a.reseed();
		await a.adjustProgram({ op: "setExerciseWeight", exercise: "Romanian Deadlift", weight: 105 }, { source: "coach", reason: "back tweak" });
		await a.adjustProgram({ op: "advanceWeek" }, { source: "coach" });
		const top = (await a.getProgramChanges(5))[0];
		const rdl = top.detail.find((d: { exercise: string | null }) => d.exercise === "Romanian Deadlift");
		expect(rdl.before).toBe("4×8 @ 105"); // the override, not the week-1 plan value
		expect(rdl.after).toBe("4×8 @ 125");
	});

	// (d) Advancing past the final plan week only bumps the counter — days stay as week 8 prescribed.
	it("advanceWeek past week 8 leaves the days unchanged", async () => {
		const a = await agent("plan-past-end");
		await a.reseed();
		for (let i = 0; i < 7; i++) await a.adjustProgram({ op: "advanceWeek" });
		const wk8 = await a.getProgram();
		expect(wk8.weekIndex).toBe(8);
		expect(wk8.days[0].lifts.some((l: { exercise: string }) => l.exercise === "Front Squat 3RM Test")).toBe(true);

		await a.adjustProgram({ op: "advanceWeek" });
		const wk9 = await a.getProgram();
		expect(wk9.weekIndex).toBe(9);
		expect(wk9.days[0].lifts.some((l: { exercise: string }) => l.exercise === "Front Squat 3RM Test")).toBe(true); // untouched
		expect((await a.getProgramChanges(5))[0].summary).toContain("beyond plan");
	});

	// (e) finalizeSession snapshots the prescribed day into the previously-empty sessions.prescribed.
	it("finalizeSession stores the prescribed day's lifts on the history row", async () => {
		const a = await agent("plan-prescribed");
		await a.reseed(); // most recent seed session is Day C → today is Day A (Front Squat)
		await a.logSet({ exercise: "Front Squat", reps: 8, weight: 125 });
		const res = await a.finalizeSession();
		expect(res.ok).toBe(true);

		const q = await a.runReadOnlyQuery("SELECT prescribed FROM sessions WHERE id LIKE 'live-%'");
		expect(q.rows.length).toBe(1);
		const prescribed = JSON.parse(q.rows[0].prescribed);
		expect(prescribed.week).toBe(1);
		expect(prescribed.focus).toBe("Front Squat");
		expect(prescribed.lifts.length).toBe(8);
		expect(prescribed.lifts[0]).toMatchObject({ exercise: "Front Squat", sets: 4, reps: 8, weight: 125 });
	});

	// (f) setExerciseWeight on a BW+X lift moves addedWeight, never fabricating a bar weight.
	it("setExerciseWeight updates addedWeight on a BW+X lift", async () => {
		const a = await agent("plan-bwx");
		await a.reseed();
		for (let i = 0; i < 3; i++) await a.adjustProgram({ op: "advanceWeek" }); // week 4: Pull-ups 4×6 @ BW+10
		const res = await a.adjustProgram({ op: "setExerciseWeight", exercise: "Pull-ups", weight: 15 }, { source: "coach" });
		expect(res.changed).toContain("Pull-ups");
		const pull = (await a.getProgram()).days[0].lifts.find((l: { exercise: string }) => l.exercise === "Pull-ups");
		expect(pull.addedWeight).toBe(15);
		expect(pull.weight).toBeUndefined();
	});

	// (g) getTrainingPlan exposes the committed plan (whole block, or one token-bounded week).
	it("getTrainingPlan returns the block and filters to a single week", async () => {
		const a = await agent("plan-read");
		await a.reseed();
		const all = await a.getTrainingPlan();
		expect(all.totalWeeks).toBe(8);
		expect(all.currentWeek).toBe(1);
		expect(all.weeks.length).toBe(8);
		const one = await a.getTrainingPlan(2);
		expect(one.weeks.length).toBe(1);
		expect(one.weeks[0].week).toBe(2);
		expect(one.weeks[0].days[0].lifts[0]).toMatchObject({ exercise: "Front Squat", weight: 130 });
	});

	// (h) /plan renders the block position ("week 1 of 8") and the next-week preview box.
	it("/plan shows week-of-block and next week's targets", async () => {
		const a = await agent("me");
		await a.reseed();
		const html = await (await SELF.fetch("https://example.com/plan")).text();
		expect(html).toContain("of 8");
		expect(html).toContain("next week · week 2");
		expect(html).toContain("Front Squat 4×8 @ 130");
	});

	// (i) On the final week /plan flags RETEST, renders the test-protocol note, and drops the
	// next-week box (there is no week 9).
	it("/plan on week 8 shows the RETEST label and protocol note", async () => {
		const a = await agent("me");
		await a.reseed();
		for (let i = 0; i < 7; i++) await a.adjustProgram({ op: "advanceWeek" });
		const html = await (await SELF.fetch("https://example.com/plan")).text();
		expect(html).toContain("RETEST");
		expect(html).toContain("stretch 180–185");
		expect(html).not.toContain("next week · week 9");
		await a.reseed(); // leave the shared "me" DO pristine for other tests
	});
});

describe("liftty coach token usage (REAL-TOKEN-USAGE)", () => {
	// recordCoachUsage() is the seam the /chat handler calls with the AI SDK's result.totalUsage — the
	// real token counts AI Gateway can't surface for these streamed responses. We exercise it directly
	// (no live model call) and assert it persists to model_usage AND emits a coach_usage event.
	it("persists a coach turn to model_usage and emits a coach_usage backfill event", async () => {
		const a = await agent("coach-usage");
		await a.reseed();
		a.recordCoachUsage({ mode: "tools", inputTokens: 6510, outputTokens: 467, steps: 2, authoredPlugin: null });

		const snap = await a.getDbSnapshot();
		const mu = snap.tables.find((t: { name: string }) => t.name === "model_usage");
		expect(mu).toBeTruthy();
		expect(mu.rowCount).toBe(1);
		expect(mu.columns).toContain("total_tokens");
		expect(mu.rows[0].total_tokens).toBe(6977);
		expect(mu.rows[0].input_tokens).toBe(6510);
		expect(mu.rows[0].mode).toBe("tools");

		// The same turn is emitted as a coach_usage event so a reconnecting /flow client backfills a real
		// per-re-derivation token figure for the ledger.
		const pe = snap.tables.find((t: { name: string }) => t.name === "plugin_events");
		const coach = (pe.rows as Array<{ payload: string }>)
			.map((r) => JSON.parse(r.payload))
			.filter((p: { type: string }) => p.type === "coach_usage");
		expect(coach.length).toBe(1);
		expect(coach[0].totalTokens).toBe(6977);
	});

	it("prunes model_usage to <= 50 rows and records the authored plugin name", async () => {
		const a = await agent("coach-usage-prune");
		await a.reseed();
		for (let i = 0; i < 55; i++) {
			a.recordCoachUsage({ mode: "codemode", inputTokens: 100 + i, outputTokens: 10, steps: 1, authoredPlugin: i === 54 ? "auto-regulate" : null });
		}
		const snap = await a.getDbSnapshot();
		const mu = snap.tables.find((t: { name: string }) => t.name === "model_usage");
		expect(mu.rowCount).toBe(50);
		// newest-first: the most recent row carries the authored plugin name
		expect(mu.rows[0].authored_plugin).toBe("auto-regulate");
	});
});

/**
 * A live WebSocket to a named DO, so tests can drive the REAL onMessage dispatch rather than calling
 * the RPC methods it happens to delegate to. `sendAndWait` resolves on the first frame matching a
 * predicate; `seen` accumulates everything for after-the-fact assertions.
 */
async function openSocket(name: string) {
	const resp = await SELF.fetch(`https://example.com/agents/liftty-agent/${name}`, { headers: { Upgrade: "websocket" } });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ws = (resp as any).webSocket as WebSocket | null;
	if (!ws) throw new Error("no webSocket on upgrade response");
	ws.accept();
	const seen: Record<string, unknown>[] = [];
	ws.addEventListener("message", (e: MessageEvent) => {
		try {
			seen.push(JSON.parse(typeof e.data === "string" ? e.data : ""));
		} catch {
			/* ignore non-JSON */
		}
	});
	return {
		seen,
		settle: () => new Promise((r) => setTimeout(r, 120)),
		close: () => {
			try {
				ws.close();
			} catch {
				/* already closed */
			}
		},
		sendAndWait(frame: Record<string, unknown>, match: (m: Record<string, unknown>) => boolean) {
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no frame matched after sending ${JSON.stringify(frame)}`)), 5000);
				const on = (e: MessageEvent) => {
					let m: Record<string, unknown>;
					try {
						m = JSON.parse(typeof e.data === "string" ? e.data : "");
					} catch {
						return;
					}
					if (!match(m)) return;
					clearTimeout(timer);
					ws.removeEventListener("message", on as never);
					resolve(m);
				};
				ws.addEventListener("message", on as never);
				ws.send(JSON.stringify(frame));
			});
		},
	};
}

// BLOCK-VIEW: week-scoped progress, explicit day selection, week navigation, and the /block route.
describe("liftty block view + week progression (BLOCK-VIEW)", () => {
	/** Log `n` sets on the currently-active day and finalize it. */
	async function logDay(a: Awaited<ReturnType<typeof agent>>, day: string, sets = 2) {
		const started = await a.startSession({ day });
		expect(started.ok).toBe(true);
		for (let i = 0; i < sets; i++) a.logSet({ exercise: started.day, reps: 5, weight: 100 });
		return await a.finalizeSession();
	}

	// (a) THE regression guard for this change. SEED_SESSIONS carries `week: 1` for Day A, Day B AND
	// Day C, so deriving week completion from actuals.week alone reports "week 1 complete — advance"
	// on a pristine install. Only the `block` tag written by finalizeSession separates them.
	it("ignores the seeded pre-block history when measuring week progress", async () => {
		const a = await agent("wp-pristine");
		await a.reseed();
		const plan = await a.getPlanData();
		expect(plan.week).toEqual({ index: 1, done: [], complete: false });
		expect(plan.today).toBe(0); // Day A is up, not "the day after the last seeded session"
		const block = await a.getBlockData();
		expect(block.weekComplete).toBe(false);
		expect(block.weeks[0].cells.every((c: { status: string }) => c.status !== "done")).toBe(true);
	});

	it("marks a day done once finalized, and the week complete after all three", async () => {
		const a = await agent("wp-complete");
		await a.reseed();
		await logDay(a, "Day A");
		expect((await a.getPlanData()).week).toEqual({ index: 1, done: ["Day A"], complete: false });
		await logDay(a, "Day B");
		await logDay(a, "Day C");
		const plan = await a.getPlanData();
		expect(plan.week).toEqual({ index: 1, done: ["Day A", "Day B", "Day C"], complete: true });
		expect((await a.getBlockData()).weekComplete).toBe(true);
	});

	// (b) Day selection. Blocking mid-session is the whole reason activeSession carries a day identity.
	it("startSession pins the chosen day, no-ops on a repeat, and refuses to switch mid-session", async () => {
		const a = await agent("start-session");
		await a.reseed();
		expect(await a.startSession({ day: "nope" })).toMatchObject({ ok: false });

		const b = await a.startSession({ day: "Day B" });
		expect(b).toMatchObject({ ok: true, day: "Incline Bench", dayLabel: "Day B", week: 1 });
		// Selecting by focus works too, and re-selecting the same day is an idempotent success.
		expect(await a.startSession({ day: "Incline Bench" })).toMatchObject({ ok: true, dayLabel: "Day B" });

		await a.logSet({ exercise: "Incline Bench", reps: 8, weight: 100 });
		expect(await a.startSession({ day: "Day C" })).toEqual({ ok: false, reason: "finish the current session first" });
		// The refusal left the live session untouched.
		expect((await a.getBlockData()).activeSession).toMatchObject({ dayLabel: "Day B", week: 1, sets: 1 });
	});

	// (c) A coach advancing the week mid-workout must not retroactively refile the session.
	it("files a session under the week it was started in, not the week it was finished in", async () => {
		const a = await agent("session-week");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.adjustProgram({ op: "advanceWeek" }); // coach moves the block mid-session
		await a.finalizeSession();
		expect((await a.getHistory("Front Squat", 1))[0].week).toBe(1);
		// …and week 2 (now current) is correctly empty.
		expect((await a.getPlanData()).week).toEqual({ index: 2, done: [], complete: false });
	});

	// (d) setWeek vs advanceWeek: shared body, deliberately different bounds.
	it("setWeek jumps forward and back within the block, clamped, while advanceWeek stays unbounded", async () => {
		const a = await agent("set-week");
		await a.reseed();
		await a.adjustProgram({ op: "setWeek", week: 5 }, { source: "lifter" });
		expect((await a.getProgram()).weekIndex).toBe(5);
		await a.adjustProgram({ op: "setWeek", week: 3 }, { source: "lifter" });
		const p = await a.getProgram();
		expect(p.weekIndex).toBe(3);
		// Week 3's committed prescriptions were loaded, not week 5's.
		expect(p.days[0].lifts[0].weight).toBe(TRAINING_PLAN.weeks[2].days[0].lifts[0].weight);

		await a.adjustProgram({ op: "setWeek", week: 99 }, { source: "lifter" });
		expect((await a.getProgram()).weekIndex).toBe(TRAINING_PLAN.weeks.length);
		await a.adjustProgram({ op: "setWeek", week: 0 }, { source: "lifter" });
		expect((await a.getProgram()).weekIndex).toBe(1);

		// advanceWeek is NOT setWeek(n+1): it still walks past the end of the block.
		await a.adjustProgram({ op: "setWeek", week: 8 }, { source: "lifter" });
		await a.adjustProgram({ op: "advanceWeek" });
		expect((await a.getProgram()).weekIndex).toBe(9);
		expect((await a.getBlockData()).beyondBlock).toBe(true);
	});

	it("records one lifter-sourced change per real week move and nothing for a no-op reload", async () => {
		const a = await agent("set-week-audit");
		await a.reseed();
		await a.adjustProgram({ op: "setWeek", week: 4 }, { source: "lifter", reason: "picked from block view" });
		const changes = await a.getProgramChanges(10);
		expect(changes.length).toBe(1);
		expect(changes[0]).toMatchObject({ op: "setWeek", source: "lifter", reason: "picked from block view" });

		// Re-picking the CURRENT week with no in-week overrides to discard must record nothing —
		// otherwise every /block visit that lands on the current week writes a "week 4 → week 4" row.
		await a.adjustProgram({ op: "setWeek", week: 4 }, { source: "lifter" });
		expect((await a.getProgramChanges(10)).length).toBe(1);

		// But it IS a real "reset this week to the plan" when there are overrides.
		await a.adjustProgram({ op: "setExerciseWeight", exercise: "Front Squat", weight: 999 });
		await a.adjustProgram({ op: "setWeek", week: 4 }, { source: "lifter" });
		const after = await a.getProgramChanges(10);
		expect(after[0].op).toBe("setWeek");
		expect(after[0].summary).toContain("reload week 4");
	});

	// (e) getBlockData: the shape /block renders, including hand-checked stats.
	it("getBlockData reports every week x day with stats on completed cells", async () => {
		const a = await agent("block-data");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 8, weight: 125 });
		await a.logSet({ exercise: "Front Squat", reps: 8, weight: 130 });
		await a.logSet({ exercise: "RDL", reps: 10, weight: 100 });
		await a.finalizeSession();

		const b = await a.getBlockData();
		expect(b.weeks.length).toBe(TRAINING_PLAN.weeks.length);
		expect(b.weeks.every((w: { cells: unknown[] }) => w.cells.length === 3)).toBe(true);
		expect(b.currentWeek).toBe(1);
		expect(b.weeks[0].current).toBe(true);

		const cell = b.weeks[0].cells[0];
		expect(cell).toMatchObject({ week: 1, day: "Day A", focus: "Front Squat", status: "done" });
		expect(cell.brief).toContain("Front Squat");
		// 8×125 + 8×130 + 10×100 = 1000 + 1040 + 1000
		expect(cell.stats).toMatchObject({ sets: 3, volume: 3040 });
		expect(cell.stats.top[0]).toEqual({ exercise: "Front Squat", weight: 130, reps: 8 });
		// Day B is the next unlogged day of the current week; a future week is neither.
		expect(b.weeks[0].cells[1].status).toBe("next");
		expect(b.weeks[3].cells[0].status).toBe("future");
		expect(b.locked).toBe(false);
	});

	it("locks day switching and week changes while a session has sets logged", async () => {
		const a = await agent("block-lock");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		expect((await a.getBlockData()).locked).toBe(true);
		expect(await a.setBlockWeek({ week: 2 })).toEqual({ ok: false, reason: "finish the current session first" });
		expect((await a.getProgram()).weekIndex).toBe(1);
		// Out-of-range weeks are refused before the session check even matters.
		await a.finalizeSession();
		expect(await a.setBlockWeek({ week: 99 })).toMatchObject({ ok: false });
		expect(await a.setBlockWeek({ week: 2 })).toEqual({ ok: true, week: 2 });
	});

	// (f) The route: GET renders, POST mutates behind a same-origin check and answers with a 303.
	it("serves /block and round-trips both POST intents as redirects", async () => {
		const res = await SELF.fetch("https://example.com/block");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const html = await res.text();
		expect(html).toContain("week 8");
		expect(html).toContain("RETEST");
		expect(html).toContain('name="intent"');

		const day = await SELF.fetch("https://example.com/block", {
			method: "POST",
			headers: { origin: "https://example.com", "content-type": "application/x-www-form-urlencoded" },
			body: "intent=day&day=Day+B",
			redirect: "manual",
		});
		expect(day.status).toBe(303);
		expect(day.headers.get("location")).toBe("/session");

		const week = await SELF.fetch("https://example.com/block", {
			method: "POST",
			headers: { origin: "https://example.com", "content-type": "application/x-www-form-urlencoded" },
			body: "intent=week&week=2",
			redirect: "manual",
		});
		expect(week.status).toBe(303);
		expect(week.headers.get("location")).toBe("/block");

		// A refusal round-trips its reason through the redirect rather than 500ing.
		const bad = await SELF.fetch("https://example.com/block", {
			method: "POST",
			headers: { origin: "https://example.com", "content-type": "application/x-www-form-urlencoded" },
			body: "intent=week&week=99",
			redirect: "manual",
		});
		expect(bad.headers.get("location")).toContain("/block?err=");
	});

	it("rejects a cross-origin POST to /block", async () => {
		const res = await SELF.fetch("https://example.com/block", {
			method: "POST",
			headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
			body: "intent=week&week=5",
			redirect: "manual",
		});
		expect(res.status).toBe(403);
	});

	it("links /block from the landing page and the shared nav", async () => {
		expect(await (await SELF.fetch("https://example.com/")).text()).toContain('href="/block"');
		expect(await (await SELF.fetch("https://example.com/plan")).text()).toContain('href="/block"');
	});

	// /plan leads with today until the week is done, then leads with the block's next move — repeating
	// a finished day as "today" is exactly the confusion this change exists to remove.
	it("/plan shows the week strip, and swaps START SESSION for the advance CTA once the week is done", async () => {
		// /plan reads the shared "me" DO, which earlier route tests have written to — reset so this
		// asserts on a known week rather than on test ordering.
		const me = await agent("me");
		await me.reseed();

		const mid = await (await SELF.fetch("https://example.com/plan")).text();
		expect(mid).toContain('class="wkstrip"');
		expect(mid).toContain("START SESSION");
		expect(mid).not.toContain("advance the block");

		for (const day of ["Day A", "Day B", "Day C"]) {
			const s = await me.startSession({ day });
			await me.logSet({ exercise: s.day, reps: 5, weight: 100 });
			await me.finalizeSession();
		}
		const done = await (await SELF.fetch("https://example.com/plan")).text();
		expect(done).toContain("complete — advance the block");
		expect(done).not.toContain("START SESSION");
	});
});

// SESSION-FIXES: the logged-set hot path and the /session client contract.
describe("liftty session logging fixes (BLOCK-VIEW)", () => {
	// A repeated frame after a half-open socket must not log the set twice.
	it("dedupes a re-sent log_set by nonce", async () => {
		const a = await agent("nonce-dedupe");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		expect((await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125, nonce: "n1" })).activeSets).toBe(1);
		expect((await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125, nonce: "n1" })).activeSets).toBe(1);
		// A different nonce is a genuinely different set, even with identical numbers.
		expect((await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125, nonce: "n2" })).activeSets).toBe(2);
		// And a set with no nonce (the coach's logSet tool) is never deduped.
		expect((await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 })).activeSets).toBe(3);
	});

	// startedAt drives both the history row's date and its id, and onConnect stamps it when /session is
	// merely OPENED. Opening the page Monday and lifting Wednesday used to file the session on Monday.
	it("dates a session from its first logged set, not from when the page was opened", async () => {
		const a = await agent("started-at");
		await a.reseed();
		await a.startSession({ day: "Day A" }); // session "opened" here
		const opened = Date.now();
		await new Promise((r) => setTimeout(r, 25));
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		const { id } = await a.finalizeSession();
		// The id is `live-<startedAt>` — parse it back out and check it was stamped at LOG time.
		expect(Date.parse(String(id).slice("live-".length))).toBeGreaterThanOrEqual(opened + 20);
	});

	// Driven through real log_set FRAMES, not by replaying the cancel/schedule pair the handler runs —
	// the regression (set 2 leaving set 1's alarm armed, so it fires early and kills the countdown)
	// lives in onMessage's ordering, and a test that performs that ordering itself proves nothing.
	it("arms exactly one rest alarm across consecutive logged sets", async () => {
		const a = await agent("rest-alarm");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		const ws = await openSocket("rest-alarm");
		for (const nonce of ["a", "b", "c"]) {
			await ws.sendAndWait({ type: "log_set", exercise: "Front Squat", reps: 5, weight: 125, nonce }, (m) => m.type === "set_logged");
		}
		expect((await a.getSchedules()).filter((s: { callback: string }) => s.callback === "restOver").length).toBe(1);
		ws.close();
	});

	// The nonce exists for the WS path: a lost frame re-sent after a reconnect must be a full no-op,
	// not just a skipped insert — restarting the rest timer or re-firing a policy would apply a
	// program change twice off one set.
	it("a re-sent log_set frame neither re-fires the policy nor restarts rest", async () => {
		const a = await agent("ws-dedupe");
		await a.reseed();
		await a.createPlugin({ name: "auto-regulate", source: AUTO_REGULATE_SRC });
		await a.startSession({ day: "Day A" });
		const ws = await openSocket("ws-dedupe");

		await ws.sendAndWait({ type: "log_set", exercise: "Front Squat", reps: 5, weight: 125, failed: true, nonce: "dup" }, (m) => m.type === "set_logged");
		await ws.settle();
		const rests = ws.seen.filter((m) => m.type === "rest_started").length;
		const fires = ws.seen.filter((m) => m.type === "plugin_fired").length;
		expect(rests).toBe(1);
		expect(fires).toBe(1);

		await ws.sendAndWait({ type: "log_set", exercise: "Front Squat", reps: 5, weight: 125, failed: true, nonce: "dup" }, (m) => m.type === "set_logged");
		await ws.settle();
		expect(ws.seen.filter((m) => m.type === "rest_started").length).toBe(rests);
		expect(ws.seen.filter((m) => m.type === "plugin_fired").length).toBe(fires);
		expect((await a.dumpState()).activeLoggedSets).toBe(1);
		ws.close();
	});

	it("acks select_day over the socket and refuses a mid-session switch", async () => {
		const a = await agent("ws-select-day");
		await a.reseed();
		const ws = await openSocket("ws-select-day");
		const ok = await ws.sendAndWait({ type: "select_day", day: "Day B" }, (m) => m.type === "select_day_result");
		expect(ok).toMatchObject({ ok: true, dayLabel: "Day B" });

		await ws.sendAndWait({ type: "log_set", exercise: "Incline Bench", reps: 8, weight: 100, nonce: "n" }, (m) => m.type === "set_logged");
		const refused = await ws.sendAndWait({ type: "select_day", day: "Day C" }, (m) => m.type === "select_day_result");
		expect(refused).toEqual({ type: "select_day_result", ok: false, reason: "finish the current session first" });
		ws.close();
	});

	/**
	 * MARKUP CONTRACT ONLY — this asserts the page ships the elements and frame names the client and
	 * server agree on. It deliberately does NOT assert on the inlined script's identifiers: checking
	 * that the served HTML contains "patchLifts" or "outbox" passes just as happily when the logic is
	 * inverted or deleted, and reads as coverage it isn't.
	 *
	 * The client behaviours those identifiers belong to — patch-vs-rebuild, the draft layer, the
	 * outbox, prefill precedence — have no automated coverage; the script is ~500 lines of ES5 inside
	 * a template literal that nothing executes. They are verified by hand in a browser. See the note
	 * in src/views/session.ts.
	 */
	it("/session ships the markup and frame names the protocol depends on", async () => {
		const html = await (await SELF.fetch("https://example.com/session")).text();
		expect(html).toContain('id="restchip"');
		expect(html).toContain('id="finish"');
		expect(html).toContain('id="lifts"');
		expect(html).toContain('id="receipts"');
		expect(html).toContain("/agents/liftty-agent/me");
		for (const frame of ["log_set", "set_rest", "set_scheme", "select_day", "session_complete"]) {
			expect(html).toContain(frame);
		}
	});
});

// BLOCK-VIEW follow-ups: the compatibility, consistency and refusal paths the first pass missed.
describe("liftty block view — compatibility + edge cases (BLOCK-VIEW)", () => {
	// THE upgrade path. Sessions finalized by the deployed version carry no `block`, so without a
	// backfill every already-logged day of the block vanishes from /block and /plan on deploy. The
	// decision is a pure function of one row, so every shape is checked here directly.
	it("migrateActuals tags a pre-tag block session and nothing else", () => {
		const legacy = { focus: "Front Squat", summary: "Front Squat 3×8 @ 125", week: 1, day: "Day A" };
		expect(migrateActuals("live-2026-07-22T10:00:00.000Z", legacy)).toEqual({ ...legacy, block: TRAINING_PLAN.id });

		// Seed rows (date ids) and reseed synthetics carry week 1 for all three days — tagging either
		// would make a pristine install report "week 1 complete, advance to week 2".
		expect(migrateActuals("2025-12-29-A", { focus: "Front Squat", week: 1, day: "Day A" })).toBeNull();
		expect(migrateActuals("synth-3", { focus: "Front Squat", week: 1, day: "Day A" })).toBeNull();
		// Already tagged, and unplaceable rows, are left alone.
		expect(migrateActuals("live-x", { week: 1, day: "Day A", block: TRAINING_PLAN.id })).toBeNull();
		expect(migrateActuals("live-x", { focus: "Front Squat" })).toBeNull();
	});

	// The tag is the durable partition key for all history, so it must be the plan's stable id and
	// never its display name — renaming the block would otherwise orphan every logged session.
	it("partitions history on the plan's stable id, not its display name", async () => {
		expect(TRAINING_PLAN.id).toBe("block-2026-07-fs-incline-hc");
		expect(TRAINING_PLAN.id).not.toBe(TRAINING_PLAN.name);
		const a = await agent("block-tag-id");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.finalizeSession();
		const snap = await a.getDbSnapshot();
		const row = snap.tables.find((t: { name: string }) => t.name === "sessions").rows.find((r: { id: string }) => r.id.startsWith("live-"));
		expect(JSON.parse(row.actuals).block).toBe(TRAINING_PLAN.id);
	});

	// The seeded Dec–Jan log carries week 1 for all three days.
	it("never counts the seeded pre-block history toward the block", async () => {
		const a = await agent("block-backfill-seeds");
		await a.reseed();
		expect((await a.getPlanData()).week).toEqual({ index: 1, done: [], complete: false });
		expect((await a.getBlockData()).weeks[0].cells.every((c: { status: string }) => c.status !== "done")).toBe(true);
	});

	// Reopening a finished day must not un-finish it: onConnect opens a session on today's day, and
	// today is index 0 once the week is complete, so this used to knock the ✓ off Day A.
	it("keeps a completed cell done while a session is live on it", async () => {
		const a = await agent("block-live-flag");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.finalizeSession();
		await a.startSession({ day: "Day A" }); // reopened

		const wk = (await a.getBlockData()).weeks[0];
		expect(wk.cells[0]).toMatchObject({ status: "done", live: true });
		expect(wk.cells[1].live).toBeUndefined();
	});

	it("reports every cell status across past, current and future weeks", async () => {
		const a = await agent("block-status-matrix");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		await a.finalizeSession();
		await a.setBlockWeek({ week: 2 });

		const b = await a.getBlockData();
		// Week 1: Day A logged, B and C skipped — "open" (a gap we moved past), never "future".
		expect(b.weeks[0].cells.map((c: { status: string }) => c.status)).toEqual(["done", "open", "open"]);
		// Week 2 is current and empty: first day is next, the rest are open.
		expect(b.weeks[1].cells.map((c: { status: string }) => c.status)).toEqual(["next", "open", "open"]);
		expect(b.weeks[2].cells.every((c: { status: string }) => c.status === "future")).toBe(true);
	});

	it("clears an empty session when the week changes so the next open re-derives the day", async () => {
		const a = await agent("set-block-week-clears");
		await a.reseed();
		await a.startSession({ day: "Day C" });
		expect((await a.getBlockData()).activeSession).toMatchObject({ dayLabel: "Day C", week: 1 });

		expect(await a.setBlockWeek({ week: 3 })).toEqual({ ok: true, week: 3 });
		expect((await a.getBlockData()).activeSession).toBeNull();

		// A session started now files under week 3, not the week it had been pinned to.
		await a.startSession({ day: "Day A" });
		await a.logSet({ exercise: "Front Squat", reps: 5, weight: 135 });
		await a.finalizeSession();
		expect((await a.getHistory("Front Squat", 1))[0].week).toBe(3);
	});

	it("counts a repeated day as extra and surfaces the newest session's stats", async () => {
		const a = await agent("block-extra");
		await a.reseed();
		for (const weight of [125, 145]) {
			await a.startSession({ day: "Day A" });
			await a.logSet({ exercise: "Front Squat", reps: 5, weight });
			await a.finalizeSession();
		}
		const cell = (await a.getBlockData()).weeks[0].cells[0];
		expect(cell.extra).toBe(1);
		expect(cell.stats.top[0].weight).toBe(145); // newest wins
		// A repeated day is still ONE day done.
		expect((await a.getPlanData()).week).toEqual({ index: 1, done: ["Day A"], complete: false });
	});

	it("rejects a non-string day over RPC instead of throwing", async () => {
		const a = await agent("start-session-types");
		await a.reseed();
		expect(await a.startSession({ day: null as never })).toMatchObject({ ok: false });
		expect(await a.startSession({ day: 3 as never })).toMatchObject({ ok: false });
		expect(await a.startSession({} as never)).toMatchObject({ ok: false, reason: "no day given" });
		// …and non-integer / out-of-range weeks are refused rather than clamped silently.
		expect(await a.setBlockWeek({ week: NaN })).toMatchObject({ ok: false });
		expect(await a.setBlockWeek({ week: 0 })).toMatchObject({ ok: false });
		expect(await a.setBlockWeek({ week: 3.7 })).toEqual({ ok: true, week: 3 });
	});

	it("round-trips every /block POST refusal as a redirect carrying its reason", async () => {
		const me = await agent("me");
		await me.reseed();
		const post = (body: string) =>
			SELF.fetch("https://example.com/block", {
				method: "POST",
				headers: { origin: "https://example.com", "content-type": "application/x-www-form-urlencoded" },
				body,
				redirect: "manual",
			});

		expect((await post("intent=day&day=Day+Z")).headers.get("location")).toContain("/block?err=");
		expect((await post("intent=day")).headers.get("location")).toContain("/block?err=");
		expect((await post("intent=week")).headers.get("location")).toContain("/block?err=");
		expect((await post("intent=bogus")).headers.get("location")).toBe("/block"); // unknown intent just bounces

		await me.startSession({ day: "Day A" });
		await me.logSet({ exercise: "Front Squat", reps: 5, weight: 125 });
		expect(decodeURIComponent((await post("intent=week&week=2")).headers.get("location")!)).toContain("finish the current session first");
		expect(decodeURIComponent((await post("intent=day&day=Day+C")).headers.get("location")!)).toContain("finish the current session first");
		await me.reseed();
	});

	it("escapes the reflected err param", async () => {
		const html = await (await SELF.fetch("https://example.com/block?err=" + encodeURIComponent('<img src=x onerror="alert(1)">'))).text();
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});

	// The coach's logSet tool must never carry a nonce — jsonSchema's additionalProperties:false is
	// advisory to the model, so a model-emitted one would turn repeat calls into silent no-ops.
	it("strips a nonce from the coach's logSet tool path", async () => {
		const a = await agent("tool-nonce");
		await a.reseed();
		await a.startSession({ day: "Day A" });
		const tools = buildTrainingTools(a);
		await tools.logSet.execute!({ exercise: "Front Squat", reps: 5, weight: 125, nonce: "x" } as never, {} as never);
		await tools.logSet.execute!({ exercise: "Front Squat", reps: 5, weight: 125, nonce: "x" } as never, {} as never);
		expect((await a.dumpState()).activeLoggedSets).toBe(2);
	});
});

// The pure domain helpers behind every /block number — no DO, no fetch.
describe("liftty lift helpers (BLOCK-VIEW)", () => {
	it("sessionStats handles empty and bodyweight sessions", () => {
		expect(sessionStats([])).toEqual({ sets: 0, volume: 0, top: [] });
		const bw = sessionStats([
			{ exercise: "Pull-ups", reps: 8, weight: 0 },
			{ exercise: "Pull-ups", reps: 6, weight: 0 },
		]);
		expect(bw).toMatchObject({ sets: 2, volume: 0 });
		expect(bw.top[0]).toEqual({ exercise: "Pull-ups", weight: 0, reps: 8 });
	});

	it("sessionStats keeps the heaviest set per exercise in first-logged order", () => {
		const s = sessionStats([
			{ exercise: "Front Squat", reps: 8, weight: 125 },
			{ exercise: "RDL", reps: 10, weight: 100 },
			{ exercise: "Front Squat", reps: 3, weight: 155 },
		]);
		expect(s.top.map((t) => t.exercise)).toEqual(["Front Squat", "RDL"]);
		expect(s.top[0]).toEqual({ exercise: "Front Squat", weight: 155, reps: 3 });
		expect(s.volume).toBe(8 * 125 + 10 * 100 + 3 * 155);
	});

	it("liftBrief covers rounds, per-side and BW+X shapes", () => {
		expect(liftBrief({ exercise: "x", kind: "rounds", sets: 3, reps: 0 })).toBe("3 rounds");
		expect(liftBrief({ exercise: "x", sets: 3, reps: 8, weight: 30, perSide: true })).toBe("3×8 @ 30/side");
		expect(liftBrief({ exercise: "x", sets: 4, reps: 6, addedWeight: 10 })).toBe("4×6 @ BW+10");
		expect(liftBrief({ exercise: "x", sets: 4, reps: 6 })).toBe("4×6");
		expect(topLiftBrief({ day: "Day A", focus: "f", lifts: [] })).toBe("");
	});

	it("summarizeSets collapses a rep range and drops a bodyweight load", () => {
		expect(
			summarizeSets([
				{ exercise: "Front Squat", reps: 8, weight: 125 },
				{ exercise: "Front Squat", reps: 5, weight: 135 },
				{ exercise: "Pull-ups", reps: 6, weight: 0 },
			]),
		).toBe("Front Squat 2×5–8 @ 135 · Pull-ups 1×6");
		expect(summarizeSets([])).toBe("");
	});
});
