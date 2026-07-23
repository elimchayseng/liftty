import { tool, jsonSchema } from "ai";
import type { PrescribedDay, MainLift } from "./server";

/**
 * The typed Training API — the centerpiece of the design.
 *
 * Four methods, not fourteen wrapper tools. `LifttyAgent` implements this interface against its
 * own state + SQLite. In M2 we expose the four as AI SDK tools (below). In M3 the SAME interface
 * is what the agent writes code against under Code Mode — the design doesn't change, only the
 * execution path does.
 *
 * Note: tool schemas are hand-written JSON Schema via `jsonSchema()`, NOT zod. Zod v4 emits a
 * top-level `$schema` key that Heroku's Anthropic-backed endpoint rejects
 * ("unrecognized request argument: $schema"). Plain JSON Schema avoids it and is provider-agnostic.
 */
export type ProgramView = {
	phase: string;
	goal: string;
	weekIndex: number;
	days: PrescribedDay[];
	mains: MainLift[];
	injuries: string[];
	status: string;
};

export type SessionLog = {
	id: string;
	date: string;
	status: string;
	week?: number;
	day?: string;
	focus?: string;
	summary?: string;
};

export type SetInput = { exercise: string; reps: number; weight?: number };

export type ProgramChange =
	| { op: "deload"; pct?: number }
	| { op: "setExerciseWeight"; exercise: string; weight: number }
	| { op: "setExerciseScheme"; exercise: string; sets?: number; reps?: number; exact?: boolean }
	| { op: "advanceWeek" }
	| { op: "setPhase"; phase: string; goal?: string };

/** adjustProgram reports exactly which exercises it touched, so the coach can report ground truth. */
export type AdjustResult = { program: ProgramView; changed: string[] };

/**
 * Provenance for a program change, stamped at the CALL SITE (never by the model): `source` is who made
 * the change ("coach" | "session-chip" | "plugin:<name>"), `reason` an optional human "why". Recorded
 * on the `program_changes` audit trail so the plan's evolution is legible after the fact.
 */
export type ChangeMeta = { source?: string; reason?: string };

export interface Training {
	getProgram(): ProgramView;
	getHistory(exercise?: string, limit?: number): SessionLog[];
	logSet(set: SetInput): { activeSets: number; message: string };
	adjustProgram(change: ProgramChange, meta?: ChangeMeta): AdjustResult;
	/** Set the default rest timer (seconds) between logged sets — persists; drives the next rest_started. */
	setRestSeconds(input: { seconds: number }): { restSeconds: number };
}

/** M5: plugin authoring surface. Kept separate from Training so the four-method centerpiece stays clean. */
export type PluginSummary = {
	id: string;
	name: string;
	version: number;
	enabled: boolean;
	created_at: string;
	last_run: string | null;
	last_result: string | null;
};

export interface PluginAuthoring {
	createPlugin(input: { name: string; source: string }): Promise<{ id: string; name: string; version: number }>;
	listPlugins(): PluginSummary[];
	setPluginEnabled(input: { id: string; enabled: boolean }): { id: string; enabled: boolean };
}

type AdjustInput = {
	op: "deload" | "setExerciseWeight" | "setExerciseScheme" | "advanceWeek" | "setPhase";
	pct?: number;
	exercise?: string;
	weight?: number;
	sets?: number;
	reps?: number;
	phase?: string;
	goal?: string;
	reason?: string;
};

/**
 * Wrap the four typed methods as AI SDK tools for the chat loop (M2, non-Code-Mode path).
 *
 * `opts.decoys` (token-measurement study): append the first N of a deterministic list of 20
 * realistic no-op tools (see `DECOY_TOOLS`). They are real `tool({...})` entries, so they add JSON
 * Schema to every tools-mode request AND (via createCodeTool in codemode.ts) generate type-block
 * lines in Code Mode — the whole point is to inflate the tool surface without changing behavior.
 * Default 0 → byte-identical to before.
 */
export function buildTrainingTools(t: Training & PluginAuthoring, opts?: { decoys?: number }) {
	const real = {
		getProgram: tool({
			description:
				"Get the lifter's current program: phase, week, prescribed days/lifts, main lifts with goals, injuries, and status. Call before answering questions about what's prescribed or before adjusting.",
			inputSchema: jsonSchema<Record<string, never>>({
				type: "object",
				properties: {},
				additionalProperties: false,
			}),
			execute: async () => t.getProgram(),
		}),
		getHistory: tool({
			description:
				"Read recent logged training sessions, newest first. Pass `exercise` (e.g. 'squat', 'incline') to filter to sessions touching that lift — use this to judge trends. `limit` defaults to 10.",
			inputSchema: jsonSchema<{ exercise?: string; limit?: number }>({
				type: "object",
				properties: {
					exercise: { type: "string", description: "Filter to sessions mentioning this lift" },
					limit: { type: "integer", minimum: 1, maximum: 200 },
				},
				additionalProperties: false,
			}),
			execute: async ({ exercise, limit }) => t.getHistory(exercise, limit),
		}),
		logSet: tool({
			description: "Log one completed set to the current session (starts a session for today if none is active).",
			inputSchema: jsonSchema<SetInput>({
				type: "object",
				properties: {
					exercise: { type: "string" },
					reps: { type: "integer", minimum: 1 },
					weight: { type: "number", description: "lb; omit for bodyweight" },
				},
				required: ["exercise", "reps"],
				additionalProperties: false,
			}),
			execute: async (set) => t.logSet(set),
		}),
		adjustProgram: tool({
			description:
				"Change the program and return { program, changed } where `changed` lists the exact exercises modified — report those to the lifter (note: `setExerciseWeight`/`setExerciseScheme` match by name substring, so 'front squat' can touch several variants). op=deload cuts working weights (optional pct, default 10); op=setExerciseWeight sets weight for lifts matching `exercise`; op=setExerciseScheme sets the sets×reps scheme for lifts matching `exercise` (pass `sets` and/or `reps` — e.g. change Pull-ups from 4×6 to 3×10; works for bodyweight lifts too); op=advanceWeek bumps the week; op=setPhase sets `phase` (and optional `goal`). Respect the lifter's injury constraints when adjusting. ALWAYS pass a short `reason` explaining WHY — it is recorded on the plan's change history so the lifter can see why the plan moved (e.g. 'missed top set 2 sessions running').",
			inputSchema: jsonSchema<AdjustInput>({
				type: "object",
				properties: {
					op: { type: "string", enum: ["deload", "setExerciseWeight", "setExerciseScheme", "advanceWeek", "setPhase"] },
					pct: { type: "number", minimum: 1, maximum: 50, description: "for deload" },
					exercise: { type: "string", description: "for setExerciseWeight / setExerciseScheme" },
					weight: { type: "number", description: "for setExerciseWeight" },
					sets: { type: "integer", minimum: 1, maximum: 20, description: "for setExerciseScheme" },
					reps: { type: "integer", minimum: 1, maximum: 100, description: "for setExerciseScheme" },
					phase: { type: "string", description: "for setPhase" },
					goal: { type: "string", description: "for setPhase" },
					reason: { type: "string", description: "short human 'why' for this change — recorded on the plan's change history" },
				},
				required: ["op"],
				additionalProperties: false,
			}),
			execute: async (c) => {
				// `source: "coach"` is stamped here, not taken from model input — the model authors the
				// `reason`, never the provenance. Same execute runs for tools-mode AND Code Mode.
				const meta = { source: "coach", reason: c.reason };
				switch (c.op) {
					case "deload":
						return t.adjustProgram({ op: "deload", pct: c.pct }, meta);
					case "setExerciseWeight":
						if (!c.exercise || c.weight == null) throw new Error("setExerciseWeight needs exercise + weight");
						return t.adjustProgram({ op: "setExerciseWeight", exercise: c.exercise, weight: c.weight }, meta);
					case "setExerciseScheme":
						if (!c.exercise || (c.sets == null && c.reps == null))
							throw new Error("setExerciseScheme needs exercise + at least one of sets/reps");
						return t.adjustProgram({ op: "setExerciseScheme", exercise: c.exercise, sets: c.sets, reps: c.reps }, meta);
					case "advanceWeek":
						return t.adjustProgram({ op: "advanceWeek" }, meta);
					case "setPhase":
						if (!c.phase) throw new Error("setPhase needs phase");
						return t.adjustProgram({ op: "setPhase", phase: c.phase, goal: c.goal }, meta);
					default:
						throw new Error(`unknown op: ${(c as { op: string }).op}`);
				}
			},
		}),
		setRestSeconds: tool({
			description:
				"Set the lifter's default rest timer (seconds) between logged sets. Persists in state and drives the rest countdown after every future set unless a set overrides it. Use when the lifter asks (e.g. 'rest 90 seconds'). Range 5–600.",
			inputSchema: jsonSchema<{ seconds: number }>({
				type: "object",
				properties: { seconds: { type: "integer", minimum: 5, maximum: 600 } },
				required: ["seconds"],
				additionalProperties: false,
			}),
			execute: async ({ seconds }) => t.setRestSeconds({ seconds }),
		}),
		// --- M5: plugin authoring. These flow into Code Mode automatically (buildCodeModeTool wraps
		// this same object), so the coach can compile a stated policy into persistent code from a
		// snippet — the spectrum's left end (ephemeral Code Mode) authoring the middle (a stored plugin).
		createPlugin: tool({
			description:
				"Compile a stated training policy into a PERSISTENT plugin that fires deterministically on every logged set with zero tokens (no LLM on the execution path). `source` is an ES module: `export default { onSetLogged(event) { return { actions, note } } }`. `event` = { set:{exercise,reps,weight}, failed, prescribed, program, recentHistory, activeSession }. Return `actions`: an array of ProgramChange — ONLY { op:'deload', pct? } or { op:'setExerciseWeight', exercise, weight } (max 3 per event). The plugin must NOT mutate anything or call the network — it returns proposed changes and the app applies them through the validated path. The source is dry-run-validated before it is saved; a bad module is rejected. Use this when the lifter states a rule they want enforced every session (e.g. 'if I fail my top set, cut it 5% next time').",
			inputSchema: jsonSchema<{ name: string; source: string }>({
				type: "object",
				properties: {
					name: { type: "string", description: "Short policy name, e.g. 'auto-regulate'" },
					source: { type: "string", description: "ES module source: export default { onSetLogged(event){ return { actions } } }" },
				},
				required: ["name", "source"],
				additionalProperties: false,
			}),
			execute: async ({ name, source }) => t.createPlugin({ name, source }),
		}),
		listPlugins: tool({
			description: "List the lifter's saved plugins (id, name, version, enabled, last run/result). Use to see what policies are currently enforced on every logged set.",
			inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
			execute: async () => t.listPlugins(),
		}),
		setPluginEnabled: tool({
			description: "Enable or disable a saved plugin by id (a disabled plugin does not fire on logged sets).",
			inputSchema: jsonSchema<{ id: string; enabled: boolean }>({
				type: "object",
				properties: { id: { type: "string" }, enabled: { type: "boolean" } },
				required: ["id", "enabled"],
				additionalProperties: false,
			}),
			execute: async ({ id, enabled }) => t.setPluginEnabled({ id, enabled }),
		}),
	};

	const n = Math.max(0, opts?.decoys ?? 0);
	if (n === 0) return real;
	// Merge the real four with the first N decoys into ONE flat tools object. Object key order is
	// insertion order, so real tools stay first and decoys follow deterministically.
	return { ...real, ...Object.fromEntries(DECOY_TOOLS.slice(0, n)) };
}

/**
 * 20 realistic-looking no-op tools for the token-measurement study, in a FIXED order. Each is a real
 * AI SDK `tool({...})` with a plausible name/description and a small hand-written `jsonSchema()`
 * (2–4 realistic props) so it contributes representative bytes to the request. None do anything —
 * every `execute` returns `{ ok: false, reason: "not available in this build" }`. The order below is
 * the contract: `buildTrainingTools(t, { decoys: N })` appends the first N of these.
 */
const noop = async () => ({ ok: false, reason: "not available in this build" }) as const;

const DECOY_TOOLS: [string, ReturnType<typeof tool<any, any>>][] = [
	[
		"logNutrition",
		tool({
			description: "Log a meal's macros and calories for the day.",
			inputSchema: jsonSchema<{ meal: string; calories?: number; proteinG?: number; carbsG?: number }>({
				type: "object",
				properties: {
					meal: { type: "string", description: "Meal name, e.g. 'breakfast'" },
					calories: { type: "integer", minimum: 0 },
					proteinG: { type: "number", minimum: 0 },
					carbsG: { type: "number", minimum: 0 },
				},
				required: ["meal"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logSleep",
		tool({
			description: "Record last night's sleep duration and quality.",
			inputSchema: jsonSchema<{ date: string; hours: number; quality?: number }>({
				type: "object",
				properties: {
					date: { type: "string", description: "ISO date" },
					hours: { type: "number", minimum: 0, maximum: 24 },
					quality: { type: "integer", minimum: 1, maximum: 5 },
				},
				required: ["date", "hours"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logCardioSession",
		tool({
			description: "Log a cardio session's type, duration, and distance.",
			inputSchema: jsonSchema<{ type: string; minutes: number; distanceKm?: number; avgHr?: number }>({
				type: "object",
				properties: {
					type: { type: "string", description: "e.g. 'run', 'row', 'bike'" },
					minutes: { type: "integer", minimum: 1 },
					distanceKm: { type: "number", minimum: 0 },
					avgHr: { type: "integer", minimum: 0 },
				},
				required: ["type", "minutes"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"trackBodyweight",
		tool({
			description: "Record a bodyweight measurement for trend tracking.",
			inputSchema: jsonSchema<{ date: string; weightLb: number }>({
				type: "object",
				properties: {
					date: { type: "string", description: "ISO date" },
					weightLb: { type: "number", minimum: 0 },
				},
				required: ["date", "weightLb"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"plateMath",
		tool({
			description: "Compute the plates per side needed for a target barbell load.",
			inputSchema: jsonSchema<{ targetWeight: number; barWeight?: number; unit?: string }>({
				type: "object",
				properties: {
					targetWeight: { type: "number", minimum: 0 },
					barWeight: { type: "number", minimum: 0, description: "default 45" },
					unit: { type: "string", enum: ["lb", "kg"] },
				},
				required: ["targetWeight"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"estimate1RM",
		tool({
			description: "Estimate a one-rep max from a weight and rep count.",
			inputSchema: jsonSchema<{ weight: number; reps: number; formula?: string }>({
				type: "object",
				properties: {
					weight: { type: "number", minimum: 0 },
					reps: { type: "integer", minimum: 1 },
					formula: { type: "string", enum: ["epley", "brzycki", "lombardi"] },
				},
				required: ["weight", "reps"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logMobility",
		tool({
			description: "Log a mobility or stretching routine and its focus area.",
			inputSchema: jsonSchema<{ area: string; minutes: number; notes?: string }>({
				type: "object",
				properties: {
					area: { type: "string", description: "e.g. 'ankles', 'hips'" },
					minutes: { type: "integer", minimum: 1 },
					notes: { type: "string" },
				},
				required: ["area", "minutes"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logSteps",
		tool({
			description: "Record a daily step count.",
			inputSchema: jsonSchema<{ date: string; steps: number }>({
				type: "object",
				properties: {
					date: { type: "string", description: "ISO date" },
					steps: { type: "integer", minimum: 0 },
				},
				required: ["date", "steps"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"setReminder",
		tool({
			description: "Schedule a reminder for a training or recovery task.",
			inputSchema: jsonSchema<{ message: string; when: string; repeat?: string }>({
				type: "object",
				properties: {
					message: { type: "string" },
					when: { type: "string", description: "ISO datetime" },
					repeat: { type: "string", enum: ["none", "daily", "weekly"] },
				},
				required: ["message", "when"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logHydration",
		tool({
			description: "Log fluid intake in ounces for the day.",
			inputSchema: jsonSchema<{ date: string; ounces: number }>({
				type: "object",
				properties: {
					date: { type: "string", description: "ISO date" },
					ounces: { type: "number", minimum: 0 },
				},
				required: ["date", "ounces"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logSoreness",
		tool({
			description: "Record perceived muscle soreness by body region.",
			inputSchema: jsonSchema<{ region: string; level: number; date?: string }>({
				type: "object",
				properties: {
					region: { type: "string", description: "e.g. 'quads', 'lower back'" },
					level: { type: "integer", minimum: 1, maximum: 5 },
					date: { type: "string" },
				},
				required: ["region", "level"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logRPE",
		tool({
			description: "Record rate of perceived exertion for a set or session.",
			inputSchema: jsonSchema<{ exercise: string; rpe: number; set?: number }>({
				type: "object",
				properties: {
					exercise: { type: "string" },
					rpe: { type: "number", minimum: 1, maximum: 10 },
					set: { type: "integer", minimum: 1 },
				},
				required: ["exercise", "rpe"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"exportProgram",
		tool({
			description: "Export the current program to a portable format.",
			inputSchema: jsonSchema<{ format: string; includeHistory?: boolean }>({
				type: "object",
				properties: {
					format: { type: "string", enum: ["json", "csv", "pdf"] },
					includeHistory: { type: "boolean" },
				},
				required: ["format"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"importProgram",
		tool({
			description: "Import a program from an external source.",
			inputSchema: jsonSchema<{ source: string; format?: string; overwrite?: boolean }>({
				type: "object",
				properties: {
					source: { type: "string", description: "URL or file id" },
					format: { type: "string", enum: ["json", "csv"] },
					overwrite: { type: "boolean" },
				},
				required: ["source"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"compareBlocks",
		tool({
			description: "Compare two training blocks by a key metric.",
			inputSchema: jsonSchema<{ blockA: string; blockB: string; metric?: string }>({
				type: "object",
				properties: {
					blockA: { type: "string" },
					blockB: { type: "string" },
					metric: { type: "string", enum: ["volume", "tonnage", "topSet"] },
				},
				required: ["blockA", "blockB"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logConditioning",
		tool({
			description: "Log a conditioning or metcon workout and its result.",
			inputSchema: jsonSchema<{ workout: string; rounds?: number; timeSec?: number }>({
				type: "object",
				properties: {
					workout: { type: "string" },
					rounds: { type: "integer", minimum: 0 },
					timeSec: { type: "integer", minimum: 0 },
				},
				required: ["workout"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"setBodyweightGoal",
		tool({
			description: "Set a target bodyweight and target date.",
			inputSchema: jsonSchema<{ targetLb: number; byDate?: string }>({
				type: "object",
				properties: {
					targetLb: { type: "number", minimum: 0 },
					byDate: { type: "string", description: "ISO date" },
				},
				required: ["targetLb"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logSupplement",
		tool({
			description: "Record a supplement taken and its dose.",
			inputSchema: jsonSchema<{ name: string; doseMg?: number; date?: string }>({
				type: "object",
				properties: {
					name: { type: "string" },
					doseMg: { type: "number", minimum: 0 },
					date: { type: "string" },
				},
				required: ["name"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"calcMacros",
		tool({
			description: "Calculate daily macro targets from bodyweight and goal.",
			inputSchema: jsonSchema<{ bodyweightLb: number; goal?: string; proteinPerLb?: number }>({
				type: "object",
				properties: {
					bodyweightLb: { type: "number", minimum: 0 },
					goal: { type: "string", enum: ["cut", "maintain", "bulk"] },
					proteinPerLb: { type: "number", minimum: 0 },
				},
				required: ["bodyweightLb"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
	[
		"logWeighIn",
		tool({
			description: "Record a scale weigh-in with an optional body-fat estimate.",
			inputSchema: jsonSchema<{ date: string; weightLb: number; bodyFatPct?: number }>({
				type: "object",
				properties: {
					date: { type: "string", description: "ISO date" },
					weightLb: { type: "number", minimum: 0 },
					bodyFatPct: { type: "number", minimum: 0, maximum: 100 },
				},
				required: ["date", "weightLb"],
				additionalProperties: false,
			}),
			execute: noop,
		}),
	],
];
