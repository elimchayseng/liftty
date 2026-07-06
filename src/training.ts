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
	| { op: "advanceWeek" }
	| { op: "setPhase"; phase: string; goal?: string };

/** adjustProgram reports exactly which exercises it touched, so the coach can report ground truth. */
export type AdjustResult = { program: ProgramView; changed: string[] };

export interface Training {
	getProgram(): ProgramView;
	getHistory(exercise?: string, limit?: number): SessionLog[];
	logSet(set: SetInput): { activeSets: number; message: string };
	adjustProgram(change: ProgramChange): AdjustResult;
}

type AdjustInput = {
	op: "deload" | "setExerciseWeight" | "advanceWeek" | "setPhase";
	pct?: number;
	exercise?: string;
	weight?: number;
	phase?: string;
	goal?: string;
};

/** Wrap the four typed methods as AI SDK tools for the chat loop (M2, non-Code-Mode path). */
export function buildTrainingTools(t: Training) {
	return {
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
					limit: { type: "integer", minimum: 1, maximum: 50 },
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
				"Change the program and return { program, changed } where `changed` lists the exact exercises modified — report those to the lifter (note: `setExerciseWeight` matches by name substring, so 'front squat' can touch several variants). op=deload cuts working weights (optional pct, default 10); op=setExerciseWeight sets weight for lifts matching `exercise`; op=advanceWeek bumps the week; op=setPhase sets `phase` (and optional `goal`). Respect the lifter's injury constraints when adjusting.",
			inputSchema: jsonSchema<AdjustInput>({
				type: "object",
				properties: {
					op: { type: "string", enum: ["deload", "setExerciseWeight", "advanceWeek", "setPhase"] },
					pct: { type: "number", minimum: 1, maximum: 50, description: "for deload" },
					exercise: { type: "string", description: "for setExerciseWeight" },
					weight: { type: "number", description: "for setExerciseWeight" },
					phase: { type: "string", description: "for setPhase" },
					goal: { type: "string", description: "for setPhase" },
				},
				required: ["op"],
				additionalProperties: false,
			}),
			execute: async (c) => {
				switch (c.op) {
					case "deload":
						return t.adjustProgram({ op: "deload", pct: c.pct });
					case "setExerciseWeight":
						if (!c.exercise || c.weight == null) throw new Error("setExerciseWeight needs exercise + weight");
						return t.adjustProgram({ op: "setExerciseWeight", exercise: c.exercise, weight: c.weight });
					case "advanceWeek":
						return t.adjustProgram({ op: "advanceWeek" });
					case "setPhase":
						if (!c.phase) throw new Error("setPhase needs phase");
						return t.adjustProgram({ op: "setPhase", phase: c.phase, goal: c.goal });
					default:
						throw new Error(`unknown op: ${(c as { op: string }).op}`);
				}
			},
		}),
	};
}
