/**
 * Committed fixtures for the repeatable demo (FLOW-LIVE-EVENTS, resetDemo) and the training block.
 *
 * - DEMO_PROGRAM: a pristine baseline program snapshot (shape = State["program"]), restored via the
 *   validated setState path on reset. Kept in JSON so it is diff-legible and applyable as data.
 * - TRAINING_PLAN: the committed multi-week block (hand-converted from eight-week-plan.csv — that
 *   CSV is kept for provenance, not parsed at runtime). Immutable reference data: the live
 *   state.program is the mutable working copy; advanceWeek copies a plan week's days into it.
 * - AUTO_REGULATE_SOURCE: the canonical plugin module the "post-author" reset profile installs
 *   through the real dry-run-validated createPlugin path. It MIRRORS fixtures/auto-regulate.js — that
 *   .js file is the source of truth; this string is what the Worker bundle imports (a raw-JS import
 *   would drag the file into the build graph, so we inline the identical source here on purpose).
 */
import type { PrescribedDay } from "../src/server";
import demoProgram from "./demo-program.json";
import trainingPlan from "./training-plan.json";

export type DemoProgram = {
	phase: string;
	goal: string;
	weekIndex: number;
	days: PrescribedDay[];
};

export const DEMO_PROGRAM = demoProgram as DemoProgram;

export type PlanWeek = {
	week: number;
	label?: string; // e.g. "RETEST" on the final test week
	days: PrescribedDay[];
};

export type TrainingPlan = {
	name: string;
	startDate?: string; // plan week 1 start (informational; rotation ignores calendar dates)
	weeks: PlanWeek[];
};

export const TRAINING_PLAN = trainingPlan as TrainingPlan;

// MIRROR of fixtures/auto-regulate.js (source of truth). Keep identical.
export const AUTO_REGULATE_SOURCE = `export default {
	onSetLogged(event) {
		if (event.failed && event.set.exercise.toLowerCase().includes("front squat")) {
			return { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 }], note: "cut after miss" };
		}
		return { actions: [] };
	}
};
`;
