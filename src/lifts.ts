import type { Lift, PrescribedDay } from "./server";

/**
 * Pure domain helpers over lifts and logged sets — no Durable Object, no SQL, no state.
 *
 * These were previously private to src/server.ts (liftBrief, summarizeSets) and duplicated in
 * src/views/plan.ts (topLiftBrief). /block needs all of them plus per-session stats, so they live
 * here and are imported by the agent and every view. The `import type` above is erased at build
 * time (fixtures/index.ts does the same), so there is no runtime cycle back into server.ts.
 */

/** One logged set as stored in `activeSession.loggedSets` / `sessions.actuals.loggedSets`. */
export type LoggedSet = { exercise: string; reps: number; weight: number };

/**
 * One-line prescription for a lift — "4×8 @ 125", "3×8 @ 30/side", "4×6 @ BW+10", "3 rounds", "4×6".
 * Used for the composite before→after strings in advanceWeek/setWeek's audit deltas (a plan-week load
 * can move sets, reps, AND weight at once, so a single weight number can't describe the change) and
 * for the per-cell brief in /block.
 */
export function liftBrief(l: Lift): string {
	const scheme = l.kind === "rounds" ? `${l.sets} rounds` : `${l.sets}×${l.reps}`;
	const load = l.weight != null ? ` @ ${l.weight}${l.perSide ? "/side" : ""}` : l.addedWeight != null ? ` @ BW+${l.addedWeight}` : "";
	return scheme + load;
}

/** The lead lift of a day as a one-line target — "Front Squat 4×8 @ 135". Used by /plan and /block. */
export function topLiftBrief(d: PrescribedDay): string {
	const l = d.lifts[0];
	if (!l) return "";
	return `${l.exercise} ${liftBrief(l)}`;
}

/**
 * Roll an active session's logged sets into one per-exercise summary line for the history row —
 * "Front Squat 4×8 @ 125 · RDL 3×8 @ 115". Groups by exercise in first-logged order; collapses a
 * rep range (5–8) when reps varied; shows the top weight per exercise (0/bodyweight → no load shown).
 */
export function summarizeSets(sets: LoggedSet[]): string {
	const order: string[] = [];
	const byEx = new Map<string, { reps: number; weight: number }[]>();
	for (const s of sets) {
		if (!byEx.has(s.exercise)) {
			byEx.set(s.exercise, []);
			order.push(s.exercise);
		}
		byEx.get(s.exercise)!.push({ reps: s.reps, weight: s.weight });
	}
	return order
		.map((ex) => {
			const list = byEx.get(ex)!;
			const reps = list.map((x) => x.reps);
			const lo = Math.min(...reps);
			const hi = Math.max(...reps);
			const repStr = lo === hi ? `${lo}` : `${lo}–${hi}`;
			const weights = list.map((x) => x.weight).filter((w) => w > 0);
			const wStr = weights.length ? ` @ ${Math.max(...weights)}` : "";
			return `${ex} ${list.length}×${repStr}${wStr}`;
		})
		.join(" · ");
}

/** Rolled-up numbers for one finished session — what a /block "done" cell shows. */
export type SessionStats = {
	sets: number;
	/** Σ reps × weight over every logged set. Bodyweight sets (weight 0) contribute nothing. */
	volume: number;
	/** Per-exercise heaviest set, in first-logged order. */
	top: { exercise: string; weight: number; reps: number }[];
};

/**
 * Numbers for a finished session: set count, total volume, and the top set per exercise.
 *
 * CAVEAT: `perSide` is deliberately NOT doubled. A logged set carries only {exercise, reps, weight} —
 * the per-side flag lives on the *prescription*, and re-deriving it at read time would silently
 * mis-scale any session whose program has since changed. Volume here is "what was logged", not a
 * biomechanical total.
 */
export function sessionStats(sets: LoggedSet[]): SessionStats {
	const order: string[] = [];
	const best = new Map<string, { weight: number; reps: number }>();
	let volume = 0;
	for (const s of sets) {
		volume += s.reps * s.weight;
		const prev = best.get(s.exercise);
		if (!prev) {
			order.push(s.exercise);
			best.set(s.exercise, { weight: s.weight, reps: s.reps });
		} else if (s.weight > prev.weight) {
			best.set(s.exercise, { weight: s.weight, reps: s.reps });
		}
	}
	return {
		sets: sets.length,
		volume,
		top: order.map((exercise) => ({ exercise, ...best.get(exercise)! })),
	};
}
