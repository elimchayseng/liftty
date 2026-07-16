/**
 * Committed fixtures for the repeatable demo (FLOW-LIVE-EVENTS, resetDemo).
 *
 * - DEMO_PROGRAM: a pristine baseline program snapshot (shape = State["program"]), restored via the
 *   validated setState path on reset. Kept in JSON so it is diff-legible and applyable as data.
 * - AUTO_REGULATE_SOURCE: the canonical plugin module the "post-author" reset profile installs
 *   through the real dry-run-validated createPlugin path. It MIRRORS fixtures/auto-regulate.js — that
 *   .js file is the source of truth; this string is what the Worker bundle imports (a raw-JS import
 *   would drag the file into the build graph, so we inline the identical source here on purpose).
 */
import type { PrescribedDay } from "../src/server";
import demoProgram from "./demo-program.json";

export type DemoProgram = {
	phase: string;
	goal: string;
	weekIndex: number;
	days: PrescribedDay[];
};

export const DEMO_PROGRAM = demoProgram as DemoProgram;

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
