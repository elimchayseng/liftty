import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { generateText } from "ai";
import { getModel } from "./model";
import { renderPlan } from "./views/plan";

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
 * The seeded `sessions` rows mirror the logged days in that CSV. Edit those files + this seed
 * together to keep the shown data honest. (A future enhancement could parse the CSV at seed time.)
 */

// --- State shape ---
export type Lift = {
	exercise: string;
	sets: number;
	reps: number;
	weight?: number; // lb; omitted for bodyweight / "each side" work
	note?: string;
};

export type PrescribedDay = {
	day: string; // "Day A"
	focus: string; // "Front Squat"
	lifts: Lift[];
};

export type MainLift = {
	name: string;
	goal3RM: number; // target 3-rep max
	decemberBest: string; // last real working sets, from the log
	rebuildOpener: number; // this block's conservative opener
};

export type State = {
	lifter: {
		name: string;
		height: string;
		bodyweight: number;
		diet: string;
		status: string; // read-first detraining note
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
					{ exercise: "Weighted Step-ups", sets: 3, reps: 8, weight: 25, note: "each side" },
					{ exercise: "Pull-ups", sets: 4, reps: 6, note: "bodyweight" },
					{ exercise: "Bulgarian Split Squats", sets: 3, reps: 8, weight: 30, note: "each side" },
					{ exercise: "Standing Calf Raises", sets: 4, reps: 15, weight: 45 },
					{ exercise: "Core Circuit", sets: 3, reps: 1, note: "rounds" },
				],
			},
			{
				day: "Day B",
				focus: "Incline Bench",
				lifts: [
					{ exercise: "Incline Bench", sets: 4, reps: 8, weight: 95, note: "known weak point — reps clean, leave 2 in the tank" },
					{ exercise: "Close-Grip Incline Press", sets: 3, reps: 8, weight: 75 },
					{ exercise: "Barbell Row", sets: 4, reps: 8, weight: 95 },
					{ exercise: "Dips", sets: 3, reps: 10, note: "bodyweight" },
					{ exercise: "Seated DB Press", sets: 3, reps: 10, weight: 30, note: "reduced load on return from layoff" },
					{ exercise: "Lateral Raises", sets: 3, reps: 12, weight: 15 },
					{ exercise: "Face Pulls", sets: 3, reps: 15, weight: 30 },
					{ exercise: "Core Circuit", sets: 3, reps: 1, note: "rounds" },
				],
			},
			{
				day: "Day C",
				focus: "Hang Clean",
				lifts: [
					{ exercise: "Hang Clean", sets: 5, reps: 3, weight: 105, note: "technique priority · stop if ankle catch flares · clean pulls only if catch degrades" },
					{ exercise: "Hang Clean Pulls", sets: 4, reps: 3, weight: 125 },
					{ exercise: "Front Squat (lighter)", sets: 3, reps: 6, weight: 115 },
					{ exercise: "Pull-ups", sets: 4, reps: 6, note: "bodyweight" },
					{ exercise: "Weighted Step-ups", sets: 3, reps: 8, weight: 25, note: "each side" },
					{ exercise: "EZ Bar Curls", sets: 3, reps: 10, weight: 45 },
					{ exercise: "Rope Pushdowns", sets: 3, reps: 10, weight: 35 },
					{ exercise: "Core Circuit", sets: 3, reps: 1, note: "rounds" },
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
	actuals: string; // JSON: { focus, summary }
};

// The real logged block from workout-log.csv (Dec 2025 – Jan 2026), summarized per day.
const SEED_SESSIONS: { id: string; date: string; focus: string; summary: string }[] = [
	{ id: "2025-12-29-A", date: "2025-12-29", focus: "Front Squat", summary: "Front Squat 4×7–8 @ 145 · pause FS 3×5 @125 · RDL 4×8 @135. Right hamstring tightness." },
	{ id: "2025-12-29-B", date: "2025-12-29", focus: "Incline Bench", summary: "Incline Bench 4×7 @ 105 · Barbell Row 4×8 @105 · Dips 3×10. Last set a grind." },
	{ id: "2026-01-05-C", date: "2026-01-05", focus: "Hang Clean", summary: "Hang Clean 5×4 @ 120 · Clean Pulls 4×3–4 @140 · light FS 3×6 @135." },
	{ id: "2026-01-07-A", date: "2026-01-07", focus: "Front Squat", summary: "Front Squat 4×7 @ 150 · pause FS 3×5 @130 · RDL 4×8 @140." },
	{ id: "2026-01-10-B", date: "2026-01-10", focus: "Incline Bench", summary: "Incline Bench 4×6 @ 110 · Barbell Row 4×6–7 @115 · Dips 3×10." },
	{ id: "2026-01-14-A", date: "2026-01-14", focus: "Front Squat", summary: "Front Squat 4×7 @ 155 (block best) · pause FS 3×5 @135 · RDL 4×8 @145 · weighted pull-ups +17.5." },
	{ id: "2026-01-16-B", date: "2026-01-16", focus: "Incline Bench", summary: "Incline Bench 4×5–6 @ 115 (hard, block best) · Barbell Row 4×8 @115 · Dips 3×10." },
	{ id: "2026-01-21-C", date: "2026-01-21", focus: "Hang Clean", summary: "Hang Clean 5×4 @ 125 (block best) · Clean Pulls 4×3 @145 · light FS 3×6 @140." },
];

const COACH_SYSTEM = `You are liftty, a concise strength coach for one lifter.
You speak plainly, reference the lifter's real numbers, and never invent PRs.`;

export class LifttyAgent extends Agent<Env, State> {
	initialState = SEED_STATE;

	/** Runs on every wake (idempotent). Create history table; seed state + logged history once. */
	async onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			date TEXT NOT NULL,
			status TEXT NOT NULL,
			prescribed TEXT NOT NULL DEFAULT '{}',
			actuals TEXT NOT NULL DEFAULT '{}'
		)`;

		// The "me" DO was created in M0 with old state; initialState won't retroactively apply.
		// Seed if the program is empty or still the placeholder 5/3/1 (real seed is a Rebuild phase).
		if (!this.state?.program?.days?.length || !this.state.program.phase.startsWith("Rebuild")) {
			this.setState(SEED_STATE);
		}

		// Seed the real logged block. INSERT OR IGNORE on fixed ids → idempotent across wakes.
		for (const s of SEED_SESSIONS) {
			const actuals = JSON.stringify({ focus: s.focus, summary: s.summary });
			this.sql`INSERT OR IGNORE INTO sessions (id, date, status, prescribed, actuals)
				VALUES (${s.id}, ${s.date}, ${"completed"}, ${"{}"}, ${actuals})`;
		}
	}

	/** RPC: everything the /plan view needs, in one round-trip. */
	async getPlanData(): Promise<{ state: State; recentSessions: SessionRow[] }> {
		const recentSessions = this.sql<SessionRow>`
			SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 10`;
		return { state: this.state, recentSessions };
	}

	/** Chat round-trip (M0). POST { message } → coach reply. (Reads state via tools in M2.) */
	async onRequest(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "POST { message } here" }, { status: 405 });
		}
		const { message } = (await request.json()) as { message?: string };
		if (!message) {
			return Response.json({ error: "missing 'message'" }, { status: 400 });
		}
		const { text } = await generateText({
			model: getModel(this.env),
			system: COACH_SYSTEM,
			prompt: message,
		});
		return Response.json({ reply: text });
	}
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

		// /session lands in M4.
		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
