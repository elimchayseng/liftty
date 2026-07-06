import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { generateText, stepCountIs } from "ai";
import { getModel } from "./model";
import { renderPlan } from "./views/plan";
import { renderChat } from "./views/chat";
import { buildCodeModeTool } from "./codemode";
import {
	buildTrainingTools,
	type Training,
	type ProgramView,
	type SessionLog,
	type SetInput,
	type ProgramChange,
	type AdjustResult,
} from "./training";

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
reporting only what actually changed (e.g. the exact exercises \`adjustProgram\` returned).`;

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

export class LifttyAgent extends Agent<Env, State> implements Training {
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
		const rows = this.sql<SessionRow>`SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 50`;
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
				const pct = change.pct ?? 10;
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
				for (const d of program.days)
					for (const l of d.lifts)
						if (l.exercise.toLowerCase().includes(q)) {
							l.weight = change.weight;
							changed.push(l.exercise);
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

	/** Admin: reset to the pristine seed (repeatable demos). Gated by a route + RESEED_TOKEN. */
	reseed(): { ok: true } {
		this.sql`DELETE FROM sessions`;
		this.seedSessions();
		this.setState(SEED_STATE);
		return { ok: true };
	}

	/** RPC: everything the /plan view needs, in one round-trip. */
	async getPlanData(): Promise<{ state: State; recentSessions: SessionRow[]; today: number }> {
		const recentSessions = this.sql<SessionRow>`
			SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 10`;
		return { state: this.state, recentSessions, today: todayIndex(this.state.program.days, recentSessions) };
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
		const { message, mode } = (await request.json()) as { message?: string; mode?: "codemode" | "tools" };
		if (!message) {
			return Response.json({ error: "missing 'message'" }, { status: 400 });
		}
		const useCodeMode = mode !== "tools"; // Code Mode is the default (M3); pass mode:"tools" to fall back

		const result = await generateText({
			model: getModel(this.env),
			system: coachSystem(this.state) + (useCodeMode ? CODEMODE_HINT : ""),
			prompt: message,
			tools: useCodeMode ? buildCodeModeTool(this, this.env.LOADER) : buildTrainingTools(this),
			// Code Mode collapses a multi-step request into one snippet, so fewer model steps are needed.
			stopWhen: stepCountIs(useCodeMode ? 5 : 8),
		});

		// Surface which tools ran across all steps. In Code Mode this is ["codemode"] even when the
		// snippet made several training.* calls — the whole point: one call, not four round-trips.
		const toolsUsed = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
		// Pull the JS snippet(s) the coach wrote (the codemode tool input) — the demo shows this.
		const code = result.steps
			.flatMap((s) => s.toolCalls)
			.filter((c) => c.toolName === "codemode")
			.map((c) => (c.input as { code?: string }).code)
			.filter((c): c is string => typeof c === "string");

		return Response.json({
			reply: result.text,
			mode: useCodeMode ? "codemode" : "tools",
			toolsUsed,
			steps: result.steps.length,
			...(code.length ? { code } : {}),
		});
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

		if (url.pathname === "/chat") {
			return new Response(renderChat(), { headers: { "content-type": "text/html; charset=utf-8" } });
		}

		// Admin reset for repeatable demos. Disabled unless RESEED_TOKEN is set (safe by default).
		if (url.pathname === "/reseed") {
			if (!env.RESEED_TOKEN) return new Response("reseed disabled — set the RESEED_TOKEN secret to enable", { status: 404 });
			if (url.searchParams.get("token") !== env.RESEED_TOKEN) return new Response("forbidden", { status: 403 });
			const me = await getAgentByName(env.LifttyAgent, "me");
			await me.reseed();
			return Response.json({ ok: true, message: "reseeded to pristine" });
		}

		// /session lands in M4.
		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
