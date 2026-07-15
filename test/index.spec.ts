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
