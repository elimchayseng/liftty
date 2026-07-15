/**
 * Liftty Plugins — persistent, model-authored training policy (M5).
 *
 * "Plugins" is OUR coined name, not a Cloudflare feature: a table of model-authored JS modules
 * stored in the agent's Durable Object, executed on a workout event via the raw Worker Loader
 * binding — the same primitive Code Mode uses (`load()`), held onto across conversations via `get()`
 * instead of thrown away. This is the "persistent runtime-generated code" middle of the spectrum
 * that no Cloudflare product owns yet (see LOADERS-VS-WFP.md). The lifecycle glue below is exactly
 * what a product would collapse into two API calls.
 *
 * DESIGN CONSTRAINT (do not over-abstract): this file is EXACTLY two public functions so its seams
 * line up 1:1 with the productized `MODULES` API argued for in PRODUCT-VISION.md. The side-by-side
 * is the demo's strongest artifact — legibility of the mapping is the point.
 *
 * ┌─────────────────────────────────────────────────────────┬──────────────────────────────────────────────┐
 * │ Hand-rolled (this file)                                  │ Productized (PRODUCT-VISION.md)                │
 * ├─────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
 * │ createPlugin({name,source}) — dry-run (uncached         │ MODULES.put(name, source,                      │
 * │   check, INSERT INTO plugins                             │   {contract, validate, capabilities})          │
 * │ runPlugins(host, event) — SELECT enabled, LOADER.get()   │ MODULES.get(name).onSetLogged(event)           │
 * │   versioned id + harness, try/catch, bookkeeping, log    │                                                │
 * │ `plugins` SQLite table                                   │ managed platform-side source storage           │
 * │ `plugin:${id}:v${version}` ids + version column          │ automatic version history / rollback           │
 * │ HARNESS_SRC wrapper + manual shape check                 │ declared, enforced `contract`                  │
 * │ globalOutbound:null + limits passed per call             │ `capabilities` manifest, declared once         │
 * │ last_run/last_result columns + console.log JSON lines    │ per-module tail + dashboard analytics          │
 * └─────────────────────────────────────────────────────────┴──────────────────────────────────────────────┘
 *
 * TRUST MODEL: the plugin is a PURE FUNCTION — data in, proposed changes out. It NEVER mutates state.
 * It returns `ProgramChange[]`, which the DO applies through the already-validated `adjustProgram`
 * path (op whitelist + action cap enforced here, not by the plugin). No `logSet` capability = no
 * recursion. `globalOutbound:null` + `limits:{cpuMs,subRequests:0}` = deny-by-default blast radius.
 * A throwing plugin is recorded in `last_result` and skipped — it can never break `logSet`.
 */
import type { ProgramChange, AdjustResult, ProgramView, SessionLog } from "./training";
import type { Lift, State } from "./server";

/** The event the DO dispatches to a plugin on every logged set. Pure data — no capabilities. */
export type PluginEvent = {
	set: { exercise: string; reps: number; weight?: number };
	failed: boolean;
	prescribed: Lift | null;
	program: ProgramView;
	recentHistory: SessionLog[];
	activeSession: State["activeSession"];
};

/** What the coach authors: `export default { onSetLogged(event) { return { actions, note? } } }`. */
export type PluginResult = { actions?: unknown; note?: string };

/** One row of the `plugins` table. */
export type PluginRow = {
	id: string;
	name: string;
	source: string;
	version: number;
	enabled: number;
	created_at: string;
	last_run: string | null;
	last_result: string | null;
};

export type PluginSummary = {
	id: string;
	name: string;
	version: number;
	enabled: boolean;
	created_at: string;
	last_run: string | null;
	last_result: string | null;
};

/** A receipt broadcast to /session per fired plugin: "auto-regulate fired · 4 ms · warm · 0 tokens". */
export type PluginReceipt = { name: string; ms: number; cold: boolean; changed: string[]; error?: string };

/**
 * Minimal capability surface plugins.ts needs from the agent. Deliberately small: the DO's SQLite
 * (`sql`), the raw Worker Loader (`loader`), and the ONE validated write path (`adjustProgram`).
 * Notably absent: `logSet` (no recursion) and `env` (the DO's `env` is protected — good).
 */
export interface PluginHost {
	sql<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
	loader: WorkerLoader;
	adjustProgram(change: ProgramChange): AdjustResult;
}

/** RPC shape the harness entrypoint exposes back to the DO. */
interface PluginEntrypoint {
	onSetLogged(event: PluginEvent): Promise<PluginResult>;
}

// Blast-radius policy, enforced HERE (not trusted to the plugin):
const MAX_ACTIONS_PER_EVENT = 3;
const ALLOWED_OPS = new Set<ProgramChange["op"]>(["deload", "setExerciseWeight"]);
const COMPAT_DATE = "2026-03-10"; // Dynamic Workers open-beta baseline
const LIMITS: { cpuMs: number; subRequests: number } = { cpuMs: 50, subRequests: 0 };

/**
 * The trusted wrapper module. Plain-object exports aren't RPC-callable, but a WorkerEntrypoint class
 * is — so the harness imports the model's `./plugin.js`, validates it exports the contract, and
 * delegates. This is fixed, trusted code; only `plugin.js` is model-authored.
 */
export const HARNESS_SRC = `
import { WorkerEntrypoint } from "cloudflare:workers";
import plugin from "./plugin.js";

export default class extends WorkerEntrypoint {
  async onSetLogged(event) {
    if (!plugin || typeof plugin.onSetLogged !== "function") {
      throw new Error("plugin must 'export default { onSetLogged(event) { ... } }'");
    }
    const out = await plugin.onSetLogged(event);
    if (out == null) return { actions: [] };
    if (typeof out !== "object" || !Array.isArray(out.actions)) {
      throw new Error("onSetLogged must return { actions: ProgramChange[], note? }");
    }
    return { actions: out.actions, note: typeof out.note === "string" ? out.note : undefined };
  }
}
`;

/**
 * A representative event for the author-time dry-run — enough for a policy to compile and run its
 * common (non-failure) path. `failed: false` on purpose: the dry-run is a COMPILE + SHAPE check, not
 * a full-path exercise, and most real events aren't failures — so we validate the ordinary path and
 * don't spuriously trip a policy's failure-only branch (e.g. one that deloads or, adversarially, calls
 * the network) at authoring time. That branch's blast radius is contained at runtime instead.
 */
const SYNTHETIC_EVENT: PluginEvent = {
	set: { exercise: "Front Squat", reps: 5, weight: 125 },
	failed: false,
	prescribed: { exercise: "Front Squat", sets: 4, reps: 8, weight: 125 },
	program: {
		phase: "dry-run",
		goal: "dry-run",
		weekIndex: 1,
		days: [{ day: "Day A", focus: "Front Squat", lifts: [{ exercise: "Front Squat", sets: 4, reps: 8, weight: 125 }] }],
		mains: [],
		injuries: [],
		status: "",
	},
	recentHistory: [],
	activeSession: { startedAt: new Date(0).toISOString(), day: "Front Squat", loggedSets: [{ exercise: "Front Squat", reps: 5, weight: 125 }] },
};

/** Slug an author-given name into a stable id: "Auto-Regulate!" → "auto-regulate". */
function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || `plugin-${Date.now().toString(36)}`;
}

/** Build the WorkerLoaderWorkerCode for a plugin id (harness + model source, deny-by-default). */
function workerCode(source: string): WorkerLoaderWorkerCode {
	return {
		compatibilityDate: COMPAT_DATE,
		mainModule: "harness.js",
		modules: { "harness.js": HARNESS_SRC, "plugin.js": source },
		globalOutbound: null, // no network: fetch()/connect() throw inside the plugin isolate
		limits: LIMITS, // cpuMs cap + zero subrequests
	};
}

/**
 * PUBLIC #1 — author-time. Prototypes `MODULES.put(name, source, {contract, validate, capabilities})`.
 *
 * Dry-runs the model's source in a one-shot (uncached) `load()` isolate against a synthetic event —
 * this is a compile + shape check you CANNOT do on a cached LLM output — then upserts into `plugins`,
 * bumping the version (which invalidates the isolate cache under the versioned id). Rejects on any
 * throw or bad shape, so a broken policy never reaches the hot path.
 */
export async function createPlugin(host: PluginHost, input: { name: string; source: string }): Promise<{ id: string; name: string; version: number }> {
	const name = (input?.name ?? "").trim();
	const source = input?.source ?? "";
	if (!name) throw new Error("createPlugin: name is required");
	if (!source.trim()) throw new Error("createPlugin: source is required");

	// Author-time dry-run: a throwaway isolate to compile + shape-check before we store. The ideal
	// primitive is one-shot `LOADER.load(code)`, but the local miniflare WorkerLoader only implements
	// `get`; a UNIQUE-per-attempt id makes `get(id, cb)` a fresh (cache-miss) isolate every time — an
	// equivalent one-shot that works in both the test runtime and prod. (A null-name get is also
	// uncached but surfaces a compile failure as a stray unhandled rejection under vitest; a unique
	// named id does not.)
	const dryRunId = `dryrun:${slugify(name)}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	let result: PluginResult;
	try {
		const stub = host.loader.get(dryRunId, () => workerCode(source));
		const ep = stub.getEntrypoint() as unknown as PluginEntrypoint;
		result = await ep.onSetLogged(SYNTHETIC_EVENT);
	} catch (err) {
		throw new Error(`createPlugin: dry-run failed — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!result || !Array.isArray(result.actions)) {
		throw new Error("createPlugin: plugin must return { actions: ProgramChange[], note? } from onSetLogged");
	}

	const id = slugify(name);
	const now = new Date().toISOString();
	const existing = host.sql<{ version: number }>`SELECT version FROM plugins WHERE id = ${id}`;
	if (existing.length) {
		const version = existing[0].version + 1; // version bump = deterministic cache invalidation
		host.sql`UPDATE plugins SET name = ${name}, source = ${source}, version = ${version}, enabled = 1, last_run = NULL, last_result = NULL WHERE id = ${id}`;
		return { id, name, version };
	}
	host.sql`INSERT INTO plugins (id, name, source, version, enabled, created_at) VALUES (${id}, ${name}, ${source}, 1, 1, ${now})`;
	return { id, name, version: 1 };
}

/**
 * PUBLIC #2 — hot path. Prototypes `MODULES.get(name).onSetLogged(event)`.
 *
 * For each enabled plugin: `LOADER.get()` with the versioned id (callback runs ONLY on cache miss →
 * truthful cold/warm flag), RPC into the harness entrypoint, apply the returned actions through the
 * validated `adjustProgram` path (op whitelist + action cap), record last_run/last_result, and emit
 * a `{plugin, ms, cold, actions}` JSON log line for `wrangler tail`. Model nowhere on this path.
 * A throwing plugin is recorded and skipped — logSet already succeeded, so it can never be broken.
 */
export async function runPlugins(host: PluginHost, event: PluginEvent): Promise<PluginReceipt[]> {
	const rows = host.sql<PluginRow>`SELECT * FROM plugins WHERE enabled = 1 ORDER BY created_at ASC`;
	const receipts: PluginReceipt[] = [];

	for (const row of rows) {
		let cold = false;
		let ms = 0;
		let changed: string[] = [];
		let error: string | undefined;
		let applied = 0;
		try {
			const stub = host.loader.get(`plugin:${row.id}:v${row.version}`, () => {
				cold = true; // callback fires only on cache miss — a real warm/cold signal
				return workerCode(row.source);
			});
			const ep = stub.getEntrypoint() as unknown as PluginEntrypoint;
			const t0 = Date.now();
			const result = await ep.onSetLogged(event); // awaited RPC = I/O, so Date.now() advances across it
			ms = Date.now() - t0;

			const actions = sanitizeActions(result?.actions);
			applied = actions.length;
			for (const action of actions) {
				const res = host.adjustProgram(action);
				changed.push(...res.changed);
			}
			changed = [...new Set(changed)];
			host.sql`UPDATE plugins SET last_run = ${new Date().toISOString()}, last_result = ${JSON.stringify({ ok: true, ms, cold, actions: applied, changed })} WHERE id = ${row.id}`;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			host.sql`UPDATE plugins SET last_run = ${new Date().toISOString()}, last_result = ${JSON.stringify({ ok: false, error })} WHERE id = ${row.id}`;
		}

		// One structured line per plugin execution → wrangler tail → RUNTIME-NOTES.md.
		console.log(JSON.stringify({ plugin: row.id, ms, cold, actions: applied, ...(error ? { error } : {}) }));
		receipts.push({ name: row.name, ms, cold, changed, ...(error ? { error } : {}) });
	}
	return receipts;
}

/**
 * Blast-radius enforcement: keep only whitelisted, well-formed ops, capped at MAX_ACTIONS_PER_EVENT.
 * The plugin cannot widen this — the DO decides what a returned action is allowed to be.
 */
function sanitizeActions(raw: unknown): ProgramChange[] {
	if (!Array.isArray(raw)) return [];
	const out: ProgramChange[] = [];
	for (const a of raw) {
		if (out.length >= MAX_ACTIONS_PER_EVENT) break;
		if (!a || typeof a !== "object") continue;
		const op = (a as { op?: unknown }).op;
		if (typeof op !== "string" || !ALLOWED_OPS.has(op as ProgramChange["op"])) continue;
		if (op === "deload") {
			const pct = (a as { pct?: unknown }).pct;
			out.push({ op: "deload", ...(typeof pct === "number" && Number.isFinite(pct) ? { pct } : {}) });
		} else if (op === "setExerciseWeight") {
			const exercise = (a as { exercise?: unknown }).exercise;
			const weight = (a as { weight?: unknown }).weight;
			if (typeof exercise !== "string" || !exercise.trim()) continue;
			if (typeof weight !== "number" || !Number.isFinite(weight)) continue;
			out.push({ op: "setExerciseWeight", exercise, weight });
		}
	}
	return out;
}

/** Map a stored row to the summary the authoring tools / views expose. */
export function toSummary(row: PluginRow): PluginSummary {
	return {
		id: row.id,
		name: row.name,
		version: row.version,
		enabled: !!row.enabled,
		created_at: row.created_at,
		last_run: row.last_run,
		last_result: row.last_result,
	};
}
