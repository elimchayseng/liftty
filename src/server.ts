import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { streamText, stepCountIs } from "ai";
import { getModel } from "./model";
import { renderPlan } from "./views/plan";
import { renderChat } from "./views/chat";
import { renderSession } from "./views/session";
import { FLOW_HTML } from "./views/flow";
import { DB_HTML } from "./views/db";
import { buildCodeModeTool } from "./codemode";
import {
	buildTrainingTools,
	type Training,
	type PluginAuthoring,
	type PluginSummary,
	type ProgramView,
	type SessionLog,
	type SetInput,
	type ProgramChange,
	type AdjustResult,
} from "./training";
import {
	createPlugin as createPluginImpl,
	runPlugins,
	toSummary,
	type PluginHost,
	type PluginRow,
	type PluginEvent,
} from "./plugins";
import { DEMO_PROGRAM, AUTO_REGULATE_SOURCE } from "../fixtures";

/**
 * liftty — a stateful lifting coach.
 *
 * One `LifttyAgent` = one Durable Object per user (routed by name; single-user demo seeds id "me").
 * State split:
 *   - Agent state (setState): lifter · program · activeSession  → hot, auto-persisted, WS-broadcast
 *   - Embedded SQLite (this.sql): sessions → append-only history
 *
 * SOURCE OF TRUTH: the seed below is derived by hand from two files committed in this repo —
 *   - prev-coach-handoff.md  (athlete profile, injuries, 3RM goals, detraining status)
 *   - workout-log.csv        (the last real training block, Dec 2025 – Jan 2026)
 * Seeding is ONE-TIME, gated by SEED_VERSION in the `meta` table — so program edits (M2) persist
 * and never get clobbered on wake. Bump SEED_VERSION to intentionally re-seed.
 */

// --- State shape ---
export type Lift = {
	exercise: string;
	sets: number;
	reps: number;
	weight?: number; // lb; omitted for bodyweight work
	perSide?: boolean; // load/reps are per side (step-ups, split squats)
	kind?: "rounds"; // circuit measured in rounds, not sets×reps
	note?: string;
};

export type PrescribedDay = {
	day: string; // "Day A"
	focus: string; // "Front Squat"
	lifts: Lift[];
};

export type MainLift = {
	name: string;
	goal3RM: number;
	decemberBest: string;
	rebuildOpener: number;
};

export type State = {
	lifter: {
		name: string;
		height: string;
		bodyweight: number;
		diet: string;
		status: string;
		injuries: string[];
		mains: MainLift[];
	};
	program: {
		phase: string;
		goal: string;
		weekIndex: number;
		days: PrescribedDay[];
	};
	activeSession: null | {
		startedAt: string;
		day: string;
		loggedSets: { exercise: string; reps: number; weight: number }[];
	};
};

// --- Seed derived from prev-coach-handoff.md + workout-log.csv ---
const SEED_VERSION = 1;

const SEED_STATE: State = {
	lifter: {
		name: "Ethan",
		height: `5'9"`,
		bodyweight: 160,
		diet: "vegetarian (160g protein training days / 128g rest)",
		status:
			"Detrained after several endurance-focused blocks. December numbers are stale — retest pending. This block reaccumulates conservatively toward December working weights before chasing 3RM goals.",
		injuries: [
			"Right ankle: torn lateral ligaments (rehabbed). Residual inversion sensitivity flares on deep front squat + hang clean catch — brace and back off if it flares.",
			"Prior 3-week illness earlier in the year cost strength.",
		],
		mains: [
			{ name: "Front Squat", goal3RM: 225, decemberBest: "4×7 @ 155 (+ pause 135×5)", rebuildOpener: 125 },
			{ name: "Incline Bench", goal3RM: 170, decemberBest: "4×5–6 @ 115 (weak point)", rebuildOpener: 95 },
			{ name: "Hang Clean", goal3RM: 185, decemberBest: "5×4 @ 125", rebuildOpener: 105 },
		],
	},
	program: {
		phase: "Rebuild · reaccumulation (3-day A/B/C)",
		goal: "Rebuild to December working weights (FS 4×7 @155 · Incline 4×6 @115 · Hang Clean 5×4 @125), then progress toward 3RM goals: FS 225 · Incline 170 · Hang Clean 185.",
		weekIndex: 1,
		days: [
			{
				day: "Day A",
				focus: "Front Squat",
				lifts: [
					{ exercise: "Front Squat", sets: 4, reps: 8, weight: 125, note: "reaccumulation opener · below Dec 145 · controlled depth, brace ankle" },
					{ exercise: "Pause Front Squat (2s)", sets: 3, reps: 5, weight: 105 },
					{ exercise: "Romanian Deadlift", sets: 4, reps: 8, weight: 115 },
					{ exercise: "Weighted Step-ups", sets: 3, reps: 8, weight: 25, perSide: true },
					{ exercise: "Pull-ups", sets: 4, reps: 6 },
					{ exercise: "Bulgarian Split Squats", sets: 3, reps: 8, weight: 30, perSide: true },
					{ exercise: "Standing Calf Raises", sets: 4, reps: 15, weight: 45 },
					{ exercise: "Core Circuit", sets: 3, reps: 0, kind: "rounds" },
				],
			},
			{
				day: "Day B",
				focus: "Incline Bench",
				lifts: [
					{ exercise: "Incline Bench", sets: 4, reps: 8, weight: 95, note: "known weak point — reps clean, leave 2 in the tank" },
					{ exercise: "Close-Grip Incline Press", sets: 3, reps: 8, weight: 75 },
					{ exercise: "Barbell Row", sets: 4, reps: 8, weight: 95 },
					{ exercise: "Dips", sets: 3, reps: 10 },
					{ exercise: "Seated DB Press", sets: 3, reps: 10, weight: 30, note: "reduced load on return from layoff" },
					{ exercise: "Lateral Raises", sets: 3, reps: 12, weight: 15 },
					{ exercise: "Face Pulls", sets: 3, reps: 15, weight: 30 },
					{ exercise: "Core Circuit", sets: 3, reps: 0, kind: "rounds" },
				],
			},
			{
				day: "Day C",
				focus: "Hang Clean",
				lifts: [
					{ exercise: "Hang Clean", sets: 5, reps: 3, weight: 105, note: "technique priority · stop if ankle catch flares · clean pulls only if catch degrades" },
					{ exercise: "Hang Clean Pulls", sets: 4, reps: 3, weight: 125 },
					{ exercise: "Front Squat (lighter)", sets: 3, reps: 6, weight: 115 },
					{ exercise: "Pull-ups", sets: 4, reps: 6 },
					{ exercise: "Weighted Step-ups", sets: 3, reps: 8, weight: 25, perSide: true },
					{ exercise: "EZ Bar Curls", sets: 3, reps: 10, weight: 45 },
					{ exercise: "Rope Pushdowns", sets: 3, reps: 10, weight: 35 },
					{ exercise: "Core Circuit", sets: 3, reps: 0, kind: "rounds" },
				],
			},
		],
	},
	activeSession: null,
};

export type SessionRow = {
	id: string;
	date: string;
	status: string;
	prescribed: string; // JSON
	actuals: string; // JSON: { focus, summary, week, day }
};

/** One shaped table in the /db read-only snapshot. `rows`/`columns` empty for count-only tables. */
export type DbTable = { name: string; rowCount: number; columns: string[]; rows: Record<string, unknown>[] };

// The real logged block from workout-log.csv (Dec 2025 – Jan 2026), summarized per day.
const SEED_SESSIONS: { id: string; date: string; week: number; day: string; focus: string; summary: string }[] = [
	{ id: "2025-12-29-A", date: "2025-12-29", week: 1, day: "Day A", focus: "Front Squat", summary: "Front Squat 4×7–8 @ 145 · pause FS 3×5 @125 · RDL 4×8 @135. Right hamstring tightness." },
	{ id: "2025-12-29-B", date: "2025-12-29", week: 1, day: "Day B", focus: "Incline Bench", summary: "Incline Bench 4×7 @ 105 · Barbell Row 4×8 @105 · Dips 3×10. Last set a grind." },
	{ id: "2026-01-05-C", date: "2026-01-05", week: 1, day: "Day C", focus: "Hang Clean", summary: "Hang Clean 5×4 @ 120 · Clean Pulls 4×3–4 @140 · light FS 3×6 @135." },
	{ id: "2026-01-07-A", date: "2026-01-07", week: 2, day: "Day A", focus: "Front Squat", summary: "Front Squat 4×7 @ 150 · pause FS 3×5 @130 · RDL 4×8 @140." },
	{ id: "2026-01-10-B", date: "2026-01-10", week: 2, day: "Day B", focus: "Incline Bench", summary: "Incline Bench 4×6 @ 110 · Barbell Row 4×6–7 @115 · Dips 3×10." },
	{ id: "2026-01-14-A", date: "2026-01-14", week: 3, day: "Day A", focus: "Front Squat", summary: "Front Squat 4×7 @ 155 (block best) · pause FS 3×5 @135 · RDL 4×8 @145 · weighted pull-ups +17.5." },
	{ id: "2026-01-16-B", date: "2026-01-16", week: 3, day: "Day B", focus: "Incline Bench", summary: "Incline Bench 4×5–6 @ 115 (hard, block best) · Barbell Row 4×8 @115 · Dips 3×10." },
	{ id: "2026-01-21-C", date: "2026-01-21", week: 2, day: "Day C", focus: "Hang Clean", summary: "Hang Clean 5×4 @ 125 (block best) · Clean Pulls 4×3 @145 · light FS 3×6 @140." },
];

/** Build the coach system prompt from live state — injects injury constraints + real numbers. */
function coachSystem(s: State): string {
	const L = s.lifter;
	const goals = L.mains.map((m) => `${m.name} 3RM ${m.goal3RM} (Dec best ${m.decemberBest})`).join("; ");
	const injuries = L.injuries.length ? L.injuries.map((i) => `- ${i}`).join("\n") : "- none noted";
	return `You are liftty, a concise strength coach for ${L.name}.
Speak plainly, reference the lifter's real numbers, and never invent PRs.

Lifter: ${L.height}, ${L.bodyweight} lb, ${L.diet}.
Status: ${L.status}
Current block: ${s.program.phase} (week ${s.program.weekIndex}) — ${s.program.goal}
Goals: ${goals}

Injury constraints — RESPECT THESE. Do not program or encourage contraindicated work:
${injuries}

When asked to program or adjust, honor the injury constraints and the current rebuild intent.`;
}

/**
 * Appended to the system prompt in Code Mode (M3). The `codemode` tool's own description already
 * teaches the mechanics (write an async arrow fn, return the result, no TS syntax); this just tells
 * the coach WHEN to reach for it and to prefer one snippet over several separate calls.
 */
const CODEMODE_HINT = `

You have one tool, \`codemode\`, exposing the typed training API as \`training.*\`. Whenever you need
to read the program/history or log sets or adjust the program, call \`codemode\` with a SINGLE async
JS snippet that does the whole task — read, compute, and write in one snippet — and return a small
result object. Prefer one snippet over multiple tool calls. Then answer the lifter in plain language,
reporting only what actually changed (e.g. the exact exercises \`adjustProgram\` returned).

PLUGINS (persistent policies). When the lifter states a RULE they want enforced on every future set
— not a one-off change — compile it into a plugin with \`training.createPlugin({ name, source })\`
instead of adjusting the program yourself. \`source\` is an ES module:
    export default { onSetLogged(event) { return { actions: [/* ProgramChange[] */], note } } }
The \`event\` is pure data: { set:{exercise,reps,weight}, failed, prescribed, program, recentHistory,
activeSession }. Return \`actions\` — an array of ProgramChange, ONLY { op:"deload", pct? } or
{ op:"setExerciseWeight", exercise, weight } (max 3 per event). The plugin is a PURE FUNCTION: it
RETURNS proposed changes and NEVER mutates state or calls the network — the runtime applies them
through the validated path and then fires the plugin on every logged set with zero tokens (no model
on that path). The source is dry-run-validated before it is saved. Use \`training.listPlugins()\` /
\`training.setPluginEnabled({ id, enabled })\` to inspect or toggle saved policies.`;

/** Experiment variant (token-measurement study). Absent → today's behavior, byte-identical. */
type PromptVariant = "parallel-nudge" | "parallel-strong" | "one-snippet";

/**
 * Tools-mode nudge: appended after the base coach prompt when variant === "parallel-nudge". Encourages
 * the model to batch independent tool calls into a single turn so we can measure parallel-call impact.
 */
const PARALLEL_NUDGE =
	"\n\nWhen multiple tool calls are independent of each other, invoke them all together in a single turn (parallel tool calls) rather than one at a time.";

/**
 * Tools-mode STRONG nudge: Anthropic's documented `<use_parallel_tool_calls>` system-prompt block
 * ("recommended if the default isn't sufficient" — platform docs, Parallel tool use). Used when
 * variant === "parallel-strong" to test the strongest documented counterfactual to the study's
 * "Sonnet serializes, so Code Mode wins" cell.
 */
const PARALLEL_STRONG = `

<use_parallel_tool_calls>
For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading the program and history, run both tool calls in parallel to read both into context at the same time; when logging several sets, emit all logSet calls together in one turn. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.
</use_parallel_tool_calls>`;

/**
 * Code-Mode replacement hint used when variant === "one-snippet": stronger "exactly one snippet"
 * framing. Used INSTEAD OF `CODEMODE_HINT` (never both) so the two hints don't stack.
 */
const ONE_SNIPPET_HINT =
	"\n\nYou have one tool, `codemode`, exposing the typed training API as `training.*`. Complete the ENTIRE task in exactly ONE snippet — never split work across multiple codemode calls. Hold intermediate results in JS variables and compute any dependent values inside that same snippet; only the final summary object returns. Then answer the lifter in plain language, reporting only what actually changed.";

/**
 * Compose the system prompt for a chat turn. Default (no variant) is byte-identical to before:
 * `coachSystem + (codemode ? CODEMODE_HINT : "")`. The two experiment variants each swap in exactly
 * one modification, and only when they apply to the active mode.
 */
function computeSystem(state: State, useCodeMode: boolean, variant?: PromptVariant): string {
	const base = coachSystem(state);
	if (useCodeMode) {
		// one-snippet REPLACES the normal hint; otherwise use the normal Code Mode hint.
		return base + (variant === "one-snippet" ? ONE_SNIPPET_HINT : CODEMODE_HINT);
	}
	// Tools mode: parallel-nudge appends a line; parallel-strong appends Anthropic's documented block.
	if (variant === "parallel-nudge") return base + PARALLEL_NUDGE;
	if (variant === "parallel-strong") return base + PARALLEL_STRONG;
	return base;
}

/** Rest timer (seconds) for a logged set: client-supplied, clamped to a sane range; default 180. */
function clampRest(rest?: number): number {
	if (typeof rest !== "number" || !Number.isFinite(rest) || rest <= 0) return 180;
	return Math.min(600, Math.max(5, Math.floor(rest)));
}

/**
 * Deterministic content hash of a program (FNV-1a over its canonical JSON), so the demo-reset
 * assertion report can prove the program was restored to the exact committed baseline.
 */
function hashProgram(program: State["program"]): string {
	const s = JSON.stringify(program);
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

/** The committed baseline program's hash — the target every reset restores to. */
const DEMO_PROGRAM_HASH = hashProgram(DEMO_PROGRAM as State["program"]);

/** Which program day is "today": the one after the most recently logged session's focus. */
function todayIndex(days: PrescribedDay[], recent: SessionRow[]): number {
	if (!days.length || !recent.length) return 0;
	try {
		const last = JSON.parse(recent[0].actuals) as { focus?: string };
		const i = days.findIndex((d) => d.focus === last.focus);
		if (i >= 0) return (i + 1) % days.length;
	} catch {
		/* fall through */
	}
	return 0;
}

export class LifttyAgent extends Agent<Env, State> implements Training, PluginAuthoring {
	initialState = SEED_STATE;

	// --- Typed Training API (M2). Same interface Code Mode will route through in M3. ---

	getProgram(): ProgramView {
		const { program, lifter } = this.state;
		return {
			phase: program.phase,
			goal: program.goal,
			weekIndex: program.weekIndex,
			days: program.days,
			mains: lifter.mains,
			injuries: lifter.injuries,
			status: lifter.status,
		};
	}

	getHistory(exercise?: string, limit = 10): SessionLog[] {
		const rows = this.sql<SessionRow>`SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 200`;
		const logs = rows.map((r): SessionLog => {
			let a: { focus?: string; summary?: string; week?: number; day?: string } = {};
			try {
				a = JSON.parse(r.actuals);
			} catch {
				/* ignore */
			}
			return { id: r.id, date: r.date, status: r.status, week: a.week, day: a.day, focus: a.focus, summary: a.summary };
		});
		const filtered = exercise
			? logs.filter((l) => `${l.focus ?? ""} ${l.summary ?? ""}`.toLowerCase().includes(exercise.toLowerCase()))
			: logs;
		return filtered.slice(0, limit);
	}

	logSet(set: SetInput): { activeSets: number; message: string } {
		// Code Mode lets the model pass computed values straight in, and jsonSchema() bounds are NOT
		// enforced at runtime — validate here. (A NaN weight would survive `?? 0` and then serialize
		// to null in storage; a non-positive/non-integer rep count is meaningless.)
		if (!Number.isInteger(set.reps) || set.reps < 1) throw new Error(`logSet: reps must be a positive integer (got ${set.reps})`);
		if (set.weight != null && !Number.isFinite(set.weight)) throw new Error(`logSet: weight must be a finite number (got ${set.weight})`);
		let active = this.state.activeSession;
		if (!active) {
			const recent = this.sql<SessionRow>`SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 1`;
			const day = this.state.program.days[todayIndex(this.state.program.days, recent)]?.focus ?? "Session";
			active = { startedAt: new Date().toISOString(), day, loggedSets: [] };
		}
		const loggedSets = [...active.loggedSets, { exercise: set.exercise, reps: set.reps, weight: set.weight ?? 0 }];
		this.setState({ ...this.state, activeSession: { ...active, loggedSets } });
		const w = set.weight != null ? ` @ ${set.weight}` : "";
		return { activeSets: loggedSets.length, message: `Logged ${set.exercise} ${set.reps}${w} (set ${loggedSets.length} of ${active.day})` };
	}

	adjustProgram(change: ProgramChange): AdjustResult {
		const program = structuredClone(this.state.program);
		const changed: string[] = [];
		switch (change.op) {
			case "deload": {
				// Clamp magnitude here, in the one validated write path, so BOTH the tools path (jsonSchema
				// min/max is NOT runtime-enforced) and the plugin path (sanitizeActions accepts any finite
				// pct) are bounded. Without this, a plugin returning pct=100 zeroes every lift and pct>100
				// goes negative — the blast radius the plugin feature exists to bound.
				const pct = Math.min(50, Math.max(1, change.pct ?? 10));
				for (const d of program.days)
					for (const l of d.lifts)
						if (l.weight != null) {
							l.weight = Math.round((l.weight * (1 - pct / 100)) / 5) * 5;
							changed.push(l.exercise);
						}
				program.phase = program.phase.replace(/ · deload wk$/, "") + " · deload wk";
				break;
			}
			case "setExerciseWeight": {
				const q = change.exercise.toLowerCase();
				const weight = Math.min(1000, Math.max(0, change.weight)); // bound magnitude (see deload note)
				for (const d of program.days)
					for (const l of d.lifts)
						if (l.exercise.toLowerCase().includes(q)) {
							l.weight = weight;
							changed.push(l.exercise);
						}
				break;
			}
			case "setExerciseScheme": {
				// Change the sets×reps prescription for matching lifts. Bounds clamped here (the one
				// validated write path) exactly like weight: sets 1–20, reps 1–100. `sets`/`reps` are
				// each optional — only the provided field changes; a lift is only "changed" if a value
				// actually moved.
				const q = change.exercise.toLowerCase();
				const clampSets = change.sets != null ? Math.min(20, Math.max(1, Math.round(change.sets))) : null;
				const clampReps = change.reps != null ? Math.min(100, Math.max(1, Math.round(change.reps))) : null;
				for (const d of program.days)
					for (const l of d.lifts)
						if (l.exercise.toLowerCase().includes(q)) {
							let touched = false;
							if (clampSets != null && l.sets !== clampSets) {
								l.sets = clampSets;
								touched = true;
							}
							if (clampReps != null && l.reps !== clampReps) {
								l.reps = clampReps;
								touched = true;
							}
							if (touched) changed.push(l.exercise);
						}
				break;
			}
			case "advanceWeek":
				program.weekIndex += 1;
				break;
			case "setPhase":
				program.phase = change.phase;
				if (change.goal) program.goal = change.goal;
				break;
		}
		this.setState({ ...this.state, program });
		return { program: this.getProgram(), changed: [...new Set(changed)] };
	}

	// --- M4: live workout session over WebSocket (hibernation + alarms) ---
	//
	// The Agents SDK wraps `onConnect`/`onMessage`: its wrapper handles the framework's own protocol
	// frames (state sync `cf_agent_state`, RPC) and forwards any OTHER message to the overrides below.
	// So our custom `{type:"log_set"}` frames land here while `setState`'s auto-broadcast + RPC keep
	// working untouched. Hibernation is automatic — between sets the DO sleeps; the socket stays open
	// and the alarm (`schedule → restOver`) wakes it. Nothing here opts out (no `hibernate:false`).

	/** The prescribed day treated as "today" — the day after the most recently logged session's focus. */
	private todayDay(): PrescribedDay {
		const recent = this.sql<SessionRow>`SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 1`;
		return this.state.program.days[todayIndex(this.state.program.days, recent)];
	}

	/** A phone opening /session: ensure an active session exists, then send the prescribed day. */
	async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
		const today = this.todayDay();
		if (!this.state.activeSession) {
			this.setState({
				...this.state,
				activeSession: { startedAt: new Date().toISOString(), day: today?.focus ?? "Session", loggedSets: [] },
			});
		}
		const dayFocus = this.state.activeSession?.day ?? today?.focus;
		const day = this.state.program.days.find((d) => d.focus === dayFocus) ?? today;
		connection.send(
			JSON.stringify({
				type: "session_hello",
				day: day?.focus ?? "Session",
				dayLabel: day?.day ?? "",
				lifts: day?.lifts ?? [],
				activeSession: this.state.activeSession,
			}),
		);

		// FLOW-LIVE-EVENTS: replay the recent event stream to THIS connection only (not a broadcast).
		// `events` is ORDERED OLDEST-FIRST (we select the newest 24 by id DESC, then reverse) so the
		// client can append them in chronological order. `modules` is the current registry snapshot.
		const events = this.sql<{ payload: string }>`SELECT payload FROM plugin_events ORDER BY id DESC LIMIT 24`
			.map((r) => {
				try {
					return JSON.parse(r.payload) as unknown;
				} catch {
					return null;
				}
			})
			.filter((e): e is Record<string, unknown> => e != null)
			.reverse();
		const modules = this.sql<{ name: string; version: number; enabled: number }>`SELECT name, version, enabled FROM plugins ORDER BY created_at ASC`.map(
			(m) => ({ name: m.name, version: m.version, enabled: !!m.enabled }),
		);
		connection.send(JSON.stringify({ type: "plugin_events_backfill", events, modules }));
	}

	/**
	 * A logged set from the phone. This is the framing-correction-#2 dispatch site: the trigger is the
	 * WS event, not an agent tool choice — no LLM call, no context window, anywhere on this path.
	 * `logSet` (already validated) mutates state (auto-broadcast), then M5 plugins fire on the event,
	 * then a rest alarm is scheduled.
	 */
	async onMessage(connection: Connection, message: WSMessage): Promise<void> {
		let msg: { type?: string; exercise?: string; reps?: number; weight?: number; failed?: boolean; rest?: number };
		try {
			msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
		} catch {
			return; // non-JSON / binary — not ours (SDK protocol frames were handled by the wrapper)
		}
		if (msg.type !== "log_set") return;
		try {
			if (!msg.exercise || typeof msg.reps !== "number") {
				connection.send(JSON.stringify({ type: "error", message: "log_set needs exercise + reps" }));
				return;
			}
			const res = this.logSet({ exercise: msg.exercise, reps: msg.reps, weight: msg.weight });
			connection.send(
				JSON.stringify({ type: "set_logged", exercise: msg.exercise, reps: msg.reps, weight: msg.weight ?? null, failed: !!msg.failed, ...res }),
			);

			// M5: persistent, model-authored plugins fire on THIS event — deterministically, zero
			// tokens, model nowhere in sight. This dispatch site is framing-correction-#2's proof:
			// the trigger is the WS event, not an agent tool choice.
			await this.firePlugins({ set: { exercise: msg.exercise, reps: msg.reps, weight: msg.weight }, failed: !!msg.failed });

			const rest = clampRest(msg.rest);
			await this.schedule(rest, "restOver", { exercise: msg.exercise });
			this.broadcast(JSON.stringify({ type: "rest_started", exercise: msg.exercise, seconds: rest }));
		} catch (err) {
			connection.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
		}
	}

	/** Rest alarm fired (DO woke from hibernation): tell every connected client the timer is up. */
	async restOver(payload: { exercise?: string }): Promise<void> {
		this.broadcast(JSON.stringify({ type: "rest_over", exercise: payload?.exercise ?? null }));
	}

	// --- M5: Liftty Plugins. Three thin authoring methods (typed + exposed as jsonSchema() tools that
	// auto-flow into Code Mode) delegate to src/plugins.ts's two public functions; firePlugins is the
	// hot-path hook the WS log_set event calls. See src/plugins.ts for the hand-rolled↔productized map.

	/** The minimal capability surface src/plugins.ts runs against (DO's `env` stays protected). */
	private pluginHost(): PluginHost {
		return {
			sql: this.sql.bind(this),
			loader: this.env.LOADER,
			adjustProgram: (change: ProgramChange) => this.adjustProgram(change),
		};
	}

	/** Author-time: dry-run + persist a model-authored policy. Prototypes MODULES.put(). */
	async createPlugin(input: { name: string; source: string }): Promise<{ id: string; name: string; version: number }> {
		try {
			const res = await createPluginImpl(this.pluginHost(), input);
			// FLOW-LIVE-EVENTS: emit plugin_created with the REAL measured dry-run latency. No
			// authorTokens field — plugins dry-run with globalOutbound:null and consume zero tokens, so
			// there is nothing truthful to report (omitted in v1 per the wire contract).
			this.recordEvent({ type: "plugin_created", name: res.name, version: res.version, dryRunMs: res.dryRunMs, at: new Date().toISOString() });
			return res;
		} catch (err) {
			// FLOW-LIVE-EVENTS: broadcast a rejection (first 120 chars of the error) BEFORE rethrowing,
			// so /flow shows the failed author attempt. The chat path still surfaces the throw to the model.
			this.recordEvent({ type: "plugin_rejected", name: (input?.name ?? "").trim() || "unnamed", error: String(err instanceof Error ? err.message : err).slice(0, 120), at: new Date().toISOString() });
			throw err;
		}
	}

	/** List saved plugins (newest bookkeeping included) for the authoring tools + /plan. */
	listPlugins(): PluginSummary[] {
		return this.sql<PluginRow>`SELECT * FROM plugins ORDER BY created_at ASC`.map(toSummary);
	}

	/** Toggle a plugin on/off; a disabled plugin is skipped by runPlugins. */
	setPluginEnabled(input: { id: string; enabled: boolean }): { id: string; enabled: boolean } {
		this.sql`UPDATE plugins SET enabled = ${input.enabled ? 1 : 0} WHERE id = ${input.id}`;
		return { id: input.id, enabled: input.enabled };
	}

	/**
	 * Hot path: fire every enabled plugin on a logged-set event and broadcast a receipt per plugin.
	 * Builds the full pure-data event from live state (plugins never read state directly), runs them
	 * via the raw Worker Loader (no LLM, no tokens), and emits `plugin_fired` so /session renders
	 * "auto-regulate fired · 4 ms · warm · 0 tokens". Wrapped so a plugin can never break logSet.
	 */
	async firePlugins(input: { set: { exercise: string; reps: number; weight?: number }; failed: boolean }): Promise<void> {
		try {
			const prescribed =
				this.todayDay()?.lifts.find((l) => l.exercise.toLowerCase().includes(input.set.exercise.toLowerCase())) ?? null;
			const event: PluginEvent = {
				set: input.set,
				failed: input.failed,
				prescribed,
				program: this.getProgram(),
				recentHistory: this.getHistory(input.set.exercise, 10),
				activeSession: this.state.activeSession,
			};
			const receipts = await runPlugins(this.pluginHost(), event);
			// `setNumber` = how many sets are logged in the active session AFTER this set (logSet ran
			// first). The client renders "set N" against the fired policy.
			const setNumber = this.state.activeSession?.loggedSets.length ?? 0;
			for (const r of receipts) {
				this.recordEvent({
					type: "plugin_fired",
					name: r.name,
					version: r.version,
					ms: r.ms,
					cold: r.cold,
					actionsApplied: r.actionsApplied,
					setNumber,
					at: new Date().toISOString(),
					// `changed` (exercises touched) + optional `error` are extra fields the /session strip
					// renders; the pinned plugin_fired contract ignores unknown fields.
					changed: r.changed,
					...(r.error ? { error: r.error } : {}),
				});
			}
		} catch (err) {
			// Defensive: firePlugins must never throw into the logSet path.
			console.error("firePlugins failed:", err);
		}
	}

	/**
	 * FLOW-LIVE-EVENTS: single write path for every plugin lifecycle event. Persists the payload to
	 * `plugin_events` (rolling buffer, pruned to newest 50), THEN broadcasts the SAME payload to all
	 * connections — so persistence + broadcast stay together and a reconnecting client can backfill
	 * exactly what it missed. `at` is expected on the payload already (runtime ISO string).
	 */
	private recordEvent(payload: Record<string, unknown> & { type: string; at?: string }): void {
		const at = typeof payload.at === "string" ? payload.at : new Date().toISOString();
		this.sql`INSERT INTO plugin_events (type, payload, at) VALUES (${payload.type}, ${JSON.stringify(payload)}, ${at})`;
		this.sql`DELETE FROM plugin_events WHERE id NOT IN (SELECT id FROM plugin_events ORDER BY id DESC LIMIT 50)`;
		this.broadcast(JSON.stringify(payload));
	}

	/**
	 * REAL-TOKEN-USAGE: persist + broadcast a coach turn's real token cost, read from the AI SDK's
	 * `result.totalUsage` (NOT from AI Gateway, which logs 0 for these streamed responses — see the
	 * model_usage table comment in onStart). Stored for /db, and emitted as a `coach_usage` event
	 * (through recordEvent, so it lands in the backfill buffer) so a reconnecting /flow client can
	 * source a REAL per-re-derivation token figure for the counterfactual ledger instead of the 1,850
	 * placeholder. Public so tests can exercise it without a live model call.
	 */
	recordCoachUsage(u: { mode: string; inputTokens: number; outputTokens: number; steps: number; authoredPlugin: string | null }): void {
		const at = new Date().toISOString();
		const total = u.inputTokens + u.outputTokens;
		this.sql`INSERT INTO model_usage (at, mode, input_tokens, output_tokens, total_tokens, steps, authored_plugin)
			VALUES (${at}, ${u.mode}, ${u.inputTokens}, ${u.outputTokens}, ${total}, ${u.steps}, ${u.authoredPlugin})`;
		this.sql`DELETE FROM model_usage WHERE id NOT IN (SELECT id FROM model_usage ORDER BY id DESC LIMIT 50)`;
		this.recordEvent({
			type: "coach_usage",
			mode: u.mode,
			inputTokens: u.inputTokens,
			outputTokens: u.outputTokens,
			totalTokens: total,
			steps: u.steps,
			...(u.authoredPlugin ? { authoredPlugin: u.authoredPlugin } : {}),
			at,
		});
	}

	/** Runs on every wake (idempotent). Create tables; seed state + history ONCE per SEED_VERSION. */
	async onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			date TEXT NOT NULL,
			status TEXT NOT NULL,
			prescribed TEXT NOT NULL DEFAULT '{}',
			actuals TEXT NOT NULL DEFAULT '{}'
		)`;
		this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

		// M5: the plugin registry — memo exhibit #1, the code storage the platform doesn't provide.
		// A second table in the SAME per-user embedded SQLite DB, so it survives redeploy just like
		// `sessions`. Model-authored JS source lives here; the raw Worker Loader executes it on events.
		this.sql`CREATE TABLE IF NOT EXISTS plugins (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			source TEXT NOT NULL,
			version INTEGER NOT NULL DEFAULT 1,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			last_run TEXT,
			last_result TEXT
		)`;

		// FLOW-LIVE-EVENTS: a rolling buffer of plugin lifecycle events (fired / created / rejected /
		// demo_reset). Persisted so a reconnecting /flow client can backfill the recent stream. Pruned
		// to newest 50 on every write by recordEvent(); backfill serves the newest 24.
		this.sql`CREATE TABLE IF NOT EXISTS plugin_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT NOT NULL,
			payload TEXT NOT NULL,
			at TEXT NOT NULL
		)`;

		// FLOW-LIVE-EVENTS (demo reset): snapshots taken BEFORE a destructive resetDemo wipe, so a
		// mis-fired reset is recoverable. Newest 3 kept (pruned in backupBeforeWipe()).
		this.sql`CREATE TABLE IF NOT EXISTS demo_backups (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			payload TEXT NOT NULL
		)`;

		// REAL-TOKEN-USAGE: per-coach-turn token accounting. THE AI-GATEWAY-vs-AI-SDK GAP: AI Gateway
		// logs 0 in / 0 out for these streamed Heroku (openai-compatible) responses — it captures
		// `streamed_data: []` and never extracts the usage chunk — so the dashboard's Tokens/Cost are
		// blank. The AI SDK, given `stream_options.include_usage: true` (set in model.ts), DOES parse
		// the final usage chunk into `result.totalUsage`. So THIS table, populated from the SDK, is the
		// only honest, showable source of real token counts (feeds /db + the /flow ledger). Newest 50.
		this.sql`CREATE TABLE IF NOT EXISTS model_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			mode TEXT,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			steps INTEGER,
			authored_plugin TEXT
		)`;

		const [row] = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'seed_version'`;
		const seeded = row ? parseInt(row.value, 10) : 0;
		if (seeded >= SEED_VERSION) return; // already seeded — never clobber real edits

		this.setState(SEED_STATE);
		this.seedSessions();
		this.sql`INSERT INTO meta (key, value) VALUES ('seed_version', ${String(SEED_VERSION)})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
	}

	/** Upsert the real logged block (idempotent; a SEED_VERSION bump refreshes rows). */
	private seedSessions() {
		for (const s of SEED_SESSIONS) {
			const actuals = JSON.stringify({ focus: s.focus, summary: s.summary, week: s.week, day: s.day });
			this.sql`INSERT INTO sessions (id, date, status, prescribed, actuals)
				VALUES (${s.id}, ${s.date}, ${"completed"}, ${"{}"}, ${actuals})
				ON CONFLICT(id) DO UPDATE SET date = excluded.date, status = excluded.status, actuals = excluded.actuals`;
	}
	}

	/**
	 * Admin: reset to the pristine seed (repeatable demos). Gated by a route + RESEED_TOKEN.
	 *
	 * `extraSessions` (token-measurement study): after the normal seed, deterministically insert that
	 * many synthetic completed sessions so a fat-history read is possible. Fully deterministic — no
	 * randomness: focus cycles Day A/B/C, weights climb a few lb per synthetic "week", and dates are
	 * back-dated into `2025-06-XX` so they never collide with the 8 real Dec-2025/Jan-2026 rows.
	 */
	reseed(extraSessions?: number): { ok: true } {
		this.sql`DELETE FROM sessions`;
		this.seedSessions();
		this.setState(SEED_STATE);

		const extra = Math.max(0, Math.floor(extraSessions ?? 0));
		if (extra > 0) {
			const cycle = [
				{ day: "Day A", focus: "Front Squat", base: 100 },
				{ day: "Day B", focus: "Incline Bench", base: 80 },
				{ day: "Day C", focus: "Hang Clean", base: 90 },
			];
			for (let i = 0; i < extra; i++) {
				const c = cycle[i % 3];
				const synthWeek = Math.floor(i / 3); // 3 days per synthetic week
				const weight = c.base + synthWeek * 5; // +5 lb per synthetic week, no randomness
				// Back-date within June 2025 (day-of-month 01..28, cycling) — safely before the real rows.
				const dom = String((i % 28) + 1).padStart(2, "0");
				const id = `synth-${i}`;
				const date = `2025-06-${dom}`;
				const summary = `${c.focus} 4×8 @ ${weight} (synthetic history row ${i}).`;
				const actuals = JSON.stringify({ focus: c.focus, summary, week: synthWeek + 1, day: c.day });
				this.sql`INSERT INTO sessions (id, date, status, prescribed, actuals)
					VALUES (${id}, ${date}, ${"completed"}, ${"{}"}, ${actuals})
					ON CONFLICT(id) DO UPDATE SET date = excluded.date, status = excluded.status, actuals = excluded.actuals`;
			}
		}
		return { ok: true };
	}

	/**
	 * Debug snapshot for the token-measurement harness (gated by the /state route + RESEED_TOKEN).
	 * Flattens live program weights and counts rows/active sets so the harness can assert ground truth
	 * after a run without parsing the chat reply.
	 */
	dumpState(): { ok: true; lifts: Record<string, number>; sessions: number; activeLoggedSets: number } {
		const lifts: Record<string, number> = {};
		for (const d of this.state.program.days) {
			for (const l of d.lifts) {
				if (l.weight == null) continue; // skip bodyweight/rounds work with no load
				if (l.exercise in lifts) continue; // first occurrence wins on duplicate names
				lifts[l.exercise] = l.weight;
			}
		}
		const [row] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sessions`;
		return {
			ok: true,
			lifts,
			sessions: row?.n ?? 0,
			activeLoggedSets: this.state.activeSession?.loggedSets.length ?? 0,
		};
	}

	// --- FLOW-LIVE-EVENTS: read-only DB explorer (/db). Strictly SELECT/PRAGMA; never mutates. ---

	/**
	 * A read-only, key-gated snapshot of the embedded SQLite for the /db explorer. Whitelisted tables
	 * get per-table shaping (plugins → source split into {length,preview,full}; sessions newest 20;
	 * plugin_events newest 24); every other/internal table is reported as {name,rowCount} only. Every
	 * table is capped at 50 rows, newest-first where a timestamp/id column exists. Purely read-only —
	 * uses raw `this.ctx.storage.sql.exec` for dynamic table names (the `this.sql` tag rejects strings).
	 */
	getDbSnapshot(): { tables: DbTable[]; generatedAt: string } {
		const raw = this.ctx.storage.sql;
		// The DO SQL authorizer blocks reading `sqlite_master` (SQLITE_AUTH), so enumerate from the known
		// app schema instead of introspecting. Try/catch per table so a not-yet-created one is skipped.
		let names: string[];
		try {
			names = raw
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.toArray()
				.map((r) => r.name);
		} catch {
			names = ["demo_backups", "meta", "model_usage", "plugin_events", "plugins", "sessions"];
		}
		const detailed = new Set(["plugins", "sessions", "plugin_events", "model_usage"]);
		const tables: DbTable[] = [];
		for (const name of names) {
			let rowCount = 0;
			try {
				rowCount = Number(raw.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).toArray()[0]?.n ?? 0);
			} catch {
				continue; // table doesn't exist in this DO
			}
			if (!detailed.has(name)) {
				// Internal / non-whitelisted tables (meta, demo_backups, _cf_* bookkeeping): count only.
				tables.push({ name, rowCount, columns: [], rows: [] });
				continue;
			}
			let order = "";
			let limit = 50;
			if (name === "sessions") {
				order = "ORDER BY date DESC, id DESC";
				limit = 20;
			} else if (name === "plugin_events") {
				order = "ORDER BY id DESC";
				limit = 24;
			} else if (name === "model_usage") {
				order = "ORDER BY id DESC";
				limit = 24;
			} else if (name === "plugins") {
				order = "ORDER BY created_at DESC";
			}
			const rows = raw.exec<Record<string, SqlStorageValue>>(`SELECT * FROM "${name}" ${order} LIMIT ${limit}`).toArray();
			const columns = rows.length ? Object.keys(rows[0]) : [];
			const shaped = rows.map((r) => {
				if (name === "plugins" && typeof r.source === "string") {
					const src = r.source;
					return { ...r, source: { length: src.length, preview: src.slice(0, 200), full: src } };
				}
				return r;
			});
			tables.push({ name, rowCount, columns, rows: shaped });
		}
		return { tables, generatedAt: new Date().toISOString() };
	}

	/**
	 * Ad-hoc read-only query for the /db console. Enforces a SINGLE SELECT/PRAGMA statement (rejects a
	 * second statement / mid-string semicolon), caps rows at 50, and wraps errors. Kept strict even
	 * though this is single-user — it's the honest shape of a read-only capability.
	 */
	runReadOnlyQuery(q: string): { rows: Record<string, unknown>[]; error?: string } {
		const query = (q ?? "").trim().replace(/;\s*$/, ""); // allow one optional trailing semicolon
		if (!query) return { rows: [], error: "empty query" };
		if (query.includes(";")) return { rows: [], error: "only a single statement is allowed" };
		if (!/^\s*(SELECT|PRAGMA)\b/i.test(query)) return { rows: [], error: "only SELECT or PRAGMA queries are allowed" };
		try {
			const rows = this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(query).toArray().slice(0, 50);
			return { rows };
		} catch (err) {
			return { rows: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	// --- FLOW-LIVE-EVENTS: repeatable demo reset (+ backup/restore). Key-gated via the /reset-demo route. ---

	/** The assertion report resetDemo returns — checked against the profile's expected values. */
	private resetReport(profile: "pre-demo" | "post-author"): { profile: string; modules: number; sessions: number; events: number; programHash: string; ok: boolean } {
		const modules = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM plugins`[0]?.n ?? 0;
		const sessions = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM sessions`[0]?.n ?? 0;
		const events = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM plugin_events`[0]?.n ?? 0;
		const programHash = hashProgram(this.state.program);
		const expected = { modules: profile === "post-author" ? 1 : 0, sessions: SEED_SESSIONS.length, events: 0, programHash: DEMO_PROGRAM_HASH };
		const ok = modules === expected.modules && sessions === expected.sessions && events === expected.events && programHash === expected.programHash;
		return { profile, modules, sessions, events, programHash, ok };
	}

	/**
	 * Serialize plugins + plugin_events + the current program into `demo_backups` BEFORE any wipe, so a
	 * mis-fired reset is recoverable. Keeps only the newest 3 backups.
	 */
	private backupBeforeWipe(): void {
		const plugins = this.sql<PluginRow>`SELECT * FROM plugins ORDER BY created_at ASC`;
		const events = this.sql<{ type: string; payload: string; at: string }>`SELECT type, payload, at FROM plugin_events ORDER BY id ASC`;
		const payload = JSON.stringify({ at: new Date().toISOString(), plugins, plugin_events: events, program: this.state.program });
		this.sql`INSERT INTO demo_backups (at, payload) VALUES (${new Date().toISOString()}, ${payload})`;
		this.sql`DELETE FROM demo_backups WHERE id NOT IN (SELECT id FROM demo_backups ORDER BY id DESC LIMIT 3)`;
	}

	/** List saved pre-wipe backups (newest first), id + timestamp only. */
	listBackups(): { id: number; at: string }[] {
		return this.sql<{ id: number; at: string }>`SELECT id, at FROM demo_backups ORDER BY id DESC`.map((r) => ({ id: Number(r.id), at: r.at }));
	}

	/** Restore plugins + plugin_events + program from a backup id (round-trips a reset). */
	restoreBackup(id: number): { ok: boolean; restored?: { plugins: number; events: number }; error?: string } {
		const [row] = this.sql<{ payload: string }>`SELECT payload FROM demo_backups WHERE id = ${id}`;
		if (!row) return { ok: false, error: "backup not found" };
		let data: { plugins: PluginRow[]; plugin_events: { type: string; payload: string; at: string }[]; program: State["program"] };
		try {
			data = JSON.parse(row.payload);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		this.sql`DELETE FROM plugins`;
		for (const p of data.plugins) {
			this.sql`INSERT INTO plugins (id, name, source, version, enabled, created_at, last_run, last_result)
				VALUES (${p.id}, ${p.name}, ${p.source}, ${p.version}, ${p.enabled}, ${p.created_at}, ${p.last_run}, ${p.last_result})`;
		}
		this.sql`DELETE FROM plugin_events`;
		for (const e of data.plugin_events) {
			this.sql`INSERT INTO plugin_events (type, payload, at) VALUES (${e.type}, ${e.payload}, ${e.at})`;
		}
		this.setState({ ...this.state, program: data.program });
		return { ok: true, restored: { plugins: data.plugins.length, events: data.plugin_events.length } };
	}

	/**
	 * Repeatable demo reset. Two profiles:
	 *   - "pre-demo" (default): a clean slate — no modules, no events, pristine program + seed sessions.
	 *   - "post-author": the same clean slate, then installs the canonical auto-regulate module through
	 *     the REAL dry-run-validated createPlugin path.
	 *
	 * Order: backup BEFORE wipe → cancel any armed restOver alarms (so a stale timer can't fire
	 * mid-demo) → wipe plugins/events/sessions → reseed sessions → restore the committed baseline
	 * program via setState + clear activeSession → (post-author) install the module. The DO is
	 * single-threaded, so the synchronous SQL block runs without interleaving; the awaited steps
	 * (cancelSchedule, createPlugin) bracket it. Returns an assertion report checked against the
	 * profile's expected values, and broadcasts demo_reset so open /flow clients clear.
	 *
	 * Truthful cold-start: DELETE FROM plugins drops the id/version, so a re-created module gets a fresh
	 * version (new isolate cache key) — the first post-reset fire is HONESTLY cold, never faked.
	 */
	async resetDemo(input?: { profile?: "pre-demo" | "post-author" }): Promise<{ profile: string; modules: number; sessions: number; events: number; programHash: string; ok: boolean }> {
		const profile: "pre-demo" | "post-author" = input?.profile === "post-author" ? "post-author" : "pre-demo";

		// 1. Backup everything we're about to destroy.
		this.backupBeforeWipe();

		// 2. Cancel any armed restOver alarms so a stale rest timer can't fire mid-demo.
		for (const s of this.getSchedules()) {
			await this.cancelSchedule(s.id);
		}

		// 3. Wipe + reseed (synchronous block — no interleaving on a single-threaded DO).
		this.sql`DELETE FROM plugins`;
		this.sql`DELETE FROM plugin_events`;
		this.sql`DELETE FROM sessions`;
		this.seedSessions();
		this.setState({ ...SEED_STATE, program: structuredClone(DEMO_PROGRAM) as State["program"], activeSession: null });

		// 4. post-author: install the canonical module via the real createPlugin path (dry-run included).
		//    Uses the impl directly (not this.createPlugin) so it does NOT record a plugin_created event —
		//    a reset leaves the event buffer empty on purpose.
		if (profile === "post-author") {
			await createPluginImpl(this.pluginHost(), { name: "auto-regulate", source: AUTO_REGULATE_SOURCE });
		}

		const report = this.resetReport(profile);
		this.broadcast(JSON.stringify({ type: "demo_reset" }));
		return report;
	}

	/** RPC: everything the /plan view needs, in one round-trip. */
	async getPlanData(): Promise<{ state: State; recentSessions: SessionRow[]; today: number; plugins: PluginSummary[] }> {
		const recentSessions = this.sql<SessionRow>`
			SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 10`;
		return {
			state: this.state,
			recentSessions,
			today: todayIndex(this.state.program.days, recentSessions),
			plugins: this.listPlugins(),
		};
	}

	/**
	 * Chat round-trip. POST { message, mode? } → coach reply.
	 * The coach reads/mutates via the four typed Training methods; injury-aware via live state.
	 *
	 *   - mode "codemode" (default, M3): one `codemode` tool — the coach writes a single JS snippet
	 *     against `training.*`, run in a Dynamic Worker Loader sandbox, calls dispatched back via RPC.
	 *   - mode "tools" (M2 baseline, fallback): four AI SDK tools, called one at a time.
	 *
	 * Both drive the SAME typed interface — only the execution path differs (see src/codemode.ts).
	 */
	async onRequest(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "POST { message } here" }, { status: 405 });
		}
		// `variant` + `decoys` are token-measurement experiment axes (token study). Absent → behavior is
		// byte-identical to before.
		type ChatBody = {
			message?: string;
			mode?: "codemode" | "tools";
			runId?: string;
			model?: string;
			variant?: PromptVariant;
			decoys?: number;
		};
		let body: ChatBody;
		try {
			body = (await request.json()) as ChatBody;
		} catch {
			return Response.json({ error: "body must be JSON: { message, mode? }" }, { status: 400 });
		}
		const { message, mode, runId, model, variant, decoys } = body;
		if (!message) {
			return Response.json({ error: "missing 'message'" }, { status: 400 });
		}
		const useCodeMode = mode !== "tools"; // Code Mode is the default (M3); pass mode:"tools" to fall back
		const flowMode = useCodeMode ? "codemode" : "tools";
		// Measured runs may override the model to compare token cost / batching across models.
		const modelId = model || this.env.MODEL;

		try {
			// STREAMING is required for correctness on this endpoint: Heroku Managed Inference rejects
			// long non-streaming completions with "Request timed out. Please use streaming…", and the AI
			// SDK then retries — which the gateway logs as duplicate requests under the same run_id,
			// double-counting tokens. streamText keeps the connection alive so long codemode/large-payload
			// flows complete in one gateway request each. We consume the stream server-side (no client SSE)
			// and read the aggregated result, so the JSON response shape is unchanged.
			//
			// A `runId` marks a MEASURED run: it tags this flow's gateway requests via cf-aig-metadata so
			// the harness can group them by run_id. Normal chat (no runId) sends no metadata header.
			// No temperature is set — `claude-opus-4-8` rejects the arg and Anthropic exposes no seed; the
			// harness runs N times and reports the spread (median primary).
			const result = streamText({
				model: getModel(this.env, runId ? { runId, mode: flowMode, model: modelId, variant, decoys } : undefined),
				system: computeSystem(this.state, useCodeMode, variant),
				prompt: message,
				tools: useCodeMode ? buildCodeModeTool(this, this.env.LOADER, { decoys }) : buildTrainingTools(this, { decoys }),
				// Code Mode collapses a multi-step request into one snippet, so fewer model steps are needed.
				stopWhen: stepCountIs(useCodeMode ? 5 : 8),
			});
			await result.consumeStream(); // drain server-side so the whole multi-step run completes
			const steps = await result.steps;
			const text = await result.text;
			const usage = await result.totalUsage; // SDK-side token accounting (fallback if gateway logs 0 on streams)

			// Surface which tools ran across all steps. In Code Mode this is ["codemode"] even when the
			// snippet made several training.* calls — the whole point: one call, not four round-trips.
			const toolsUsed = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
			// Pull the JS snippet(s) the coach wrote (the codemode tool input) — the demo shows this.
			const code = steps
				.flatMap((s) => s.toolCalls)
				.filter((c) => c.toolName === "codemode")
				.map((c) => (c.input as { code?: string }).code)
				.filter((c): c is string => typeof c === "string");
			// M5: surface any plugin the coach authored this turn so /chat can show its source (reuses
			// the addCode renderer). In Code Mode the createPlugin call is inside a codemode snippet
			// (already in `code`); in Tools mode it's a top-level `createPlugin` tool call.
			const plugins = steps
				.flatMap((s) => s.toolCalls)
				.filter((c) => c.toolName === "createPlugin")
				.map((c) => c.input as { name?: string; source?: string })
				.filter((p): p is { name: string; source: string } => typeof p?.name === "string" && typeof p?.source === "string");

			// REAL-TOKEN-USAGE: record the real SDK-reported token cost of this coach turn (and note the
			// plugin it authored, if any). This is what makes the /flow ledger and /db honestly sourced.
			this.recordCoachUsage({
				mode: flowMode,
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				steps: steps.length,
				authoredPlugin: plugins.length ? plugins[0].name : null,
			});

			return Response.json({
				reply: text,
				mode: flowMode,
				toolsUsed,
				steps: steps.length,
				usageIn: usage.inputTokens ?? 0, // SDK-reported input tokens (per-flow total across steps)
				usageOut: usage.outputTokens ?? 0,
				...(runId ? { runId, model: modelId } : {}), // echoed so the harness can sanity-check the tag it sent
				...(code.length ? { code } : {}),
				...(plugins.length ? { plugins } : {}),
			});
		} catch (err) {
			// New failure surface under Code Mode: a sandbox load/entitlement error (e.g. LOADER not
			// provisioned), an AI Gateway hiccup, or a model-written snippet that won't run. Return a
			// clean message instead of a framework 500 dumping a stack trace to the client.
			console.error("chat onRequest failed:", err);
			return Response.json(
				{ error: "coach request failed to complete", mode: flowMode },
				{ status: 502 },
			);
		}
	}
}

/**
 * Key gate for /db, /db.json, /reset-demo. True only when DB_KEY is configured AND the request's
 * `?key=` matches it. A miss returns 404 (not 403) so the explorer is invisible without the key.
 */
function dbKeyOk(url: URL, env: Env): boolean {
	return !!env.DB_KEY && url.searchParams.get("key") === env.DB_KEY;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || url.pathname === "/plan") {
			const me = await getAgentByName(env.LifttyAgent, "me");
			const data = await me.getPlanData();
			return new Response(renderPlan(data), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		if (url.pathname === "/chat") {
			return new Response(renderChat(), { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		// M4: the live workout stage. Server-rendered page opens a raw WS to the agent (routed by the
		// routeAgentRequest fallthrough below at /agents/liftty-agent/me).
		if (url.pathname === "/session") {
			return new Response(renderSession(), { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		// Admin reset for repeatable demos. Disabled unless RESEED_TOKEN is set (safe by default).
		// Optional `&sessions=N` seeds N synthetic history rows on top of the pristine seed (study).
		if (url.pathname === "/reseed") {
			if (!env.RESEED_TOKEN) return new Response("reseed disabled — set the RESEED_TOKEN secret to enable", { status: 404 });
			if (url.searchParams.get("token") !== env.RESEED_TOKEN) return new Response("forbidden", { status: 403 });
			const raw = url.searchParams.get("sessions");
			const n = raw != null ? parseInt(raw, 10) : 0;
			const extra = Number.isFinite(n) && n > 0 ? n : 0;
			const me = await getAgentByName(env.LifttyAgent, "me");
			await me.reseed(extra);
			return Response.json({ ok: true, message: "reseeded to pristine", extraSessions: extra });
		}

		// Debug snapshot for the token-measurement harness. Gated EXACTLY like /reseed.
		if (url.pathname === "/state") {
			if (!env.RESEED_TOKEN) return new Response("state disabled — set the RESEED_TOKEN secret to enable", { status: 404 });
			if (url.searchParams.get("token") !== env.RESEED_TOKEN) return new Response("forbidden", { status: 403 });
			const me = await getAgentByName(env.LifttyAgent, "me");
			return Response.json(await me.dumpState());
		}

		// FLOW-LIVE-EVENTS: the live plugin-flow stage. Static bundle regenerated from
		// plugins-flow-v2.1.html; it opens the same raw WS as /session and renders the event stream.
		if (url.pathname === "/flow") {
			return new Response(FLOW_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		// FLOW-LIVE-EVENTS: read-only DB explorer. Key-gated (404 without the key → invisible). NOT
		// linked from any other page. `/db.json` GET = snapshot; POST = ad-hoc read-only query.
		if (url.pathname === "/db") {
			if (!dbKeyOk(url, env)) return new Response("Not found", { status: 404 });
			return new Response(DB_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		if (url.pathname === "/db.json") {
			if (!dbKeyOk(url, env)) return new Response("Not found", { status: 404 });
			const me = await getAgentByName(env.LifttyAgent, "me");
			if (request.method === "POST") {
				let q = "";
				try {
					q = ((await request.json()) as { query?: string }).query ?? "";
				} catch {
					return Response.json({ rows: [], error: "body must be JSON: { query }" }, { status: 400 });
				}
				return Response.json(await me.runReadOnlyQuery(q));
			}
			return Response.json(await me.getDbSnapshot());
		}

		// FLOW-LIVE-EVENTS: repeatable demo reset. Same key gate (404 without). POST only.
		if (url.pathname === "/reset-demo") {
			if (!dbKeyOk(url, env)) return new Response("Not found", { status: 404 });
			if (request.method !== "POST") return Response.json({ error: "POST /reset-demo?key=…&profile=…" }, { status: 405 });
			const profile = url.searchParams.get("profile") === "post-author" ? "post-author" : "pre-demo";
			const me = await getAgentByName(env.LifttyAgent, "me");
			const report = await me.resetDemo({ profile });
			return Response.json({ ok: true, report });
		}

		// WS upgrades (/agents/liftty-agent/me from /session) + any other agent routes.
		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
