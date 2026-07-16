import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getAgentByName } from "agents";

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
		expect(html).toContain("Receipts");
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
