// Canonical liftty plugin — the "auto-regulate" policy used by the repeatable demo (post-author
// profile) and mirrored as AUTO_REGULATE_SOURCE in fixtures/index.ts.
//
// SOURCE OF TRUTH: this file. If you change the policy, update the mirrored string in
// fixtures/index.ts to match (they are kept identical on purpose; the bundler imports the string,
// not this file, so a raw-JS import stays out of the Worker build).
//
// Contract: export default { onSetLogged(event) { return { actions: ProgramChange[], note? } } }
// On a FAILED top-set front squat, cut next session's Front Squat to a conservative 100 lb.
export default {
	onSetLogged(event) {
		if (event.failed && event.set.exercise.toLowerCase().includes("front squat")) {
			return { actions: [{ op: "setExerciseWeight", exercise: "Front Squat", weight: 100 }], note: "cut after miss" };
		}
		return { actions: [] };
	}
};
