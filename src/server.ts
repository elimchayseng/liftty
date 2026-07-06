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
 * M1: seed a lifter + 5/3/1 program, create the sessions table, server-render /plan.
 */

// --- State shape ---
export type Lift = {
	exercise: string;
	sets: number;
	reps: number;
	weight?: number;
	note?: string;
};

export type PrescribedDay = {
	day: string; // e.g. "Day 1"
	focus: string; // e.g. "Overhead Press"
	lifts: Lift[];
};

export type State = {
	lifter: {
		name: string;
		bodyweight?: number;
		prs: Record<string, number>; // estimated 1RMs
		trainingMaxes: Record<string, number>; // 5/3/1 TMs (~90% 1RM)
		injuries: string[];
	};
	program: {
		phase: string;
		goal: string;
		weekIndex: number; // 1 = 5s week, 2 = 3s week, 3 = 5/3/1 week
		days: PrescribedDay[];
	};
	activeSession: null | {
		startedAt: string;
		day: string;
		loggedSets: { exercise: string; reps: number; weight: number }[];
	};
};

// --- Seed (placeholder numbers — edit freely) ---
const SEED_STATE: State = {
	lifter: {
		name: "Ethan",
		bodyweight: 185,
		prs: { squat: 350, bench: 250, deadlift: 455, press: 160 },
		trainingMaxes: { squat: 315, bench: 225, deadlift: 405, press: 145 },
		injuries: [],
	},
	program: {
		phase: "5/3/1 — Leader",
		goal: "Build a strength base across the big four",
		weekIndex: 1, // 5s week
		days: [
			{
				day: "Day 1",
				focus: "Overhead Press",
				lifts: [
					{ exercise: "Overhead Press", sets: 1, reps: 5, weight: 125, note: "top set · 5+ AMRAP @ 85% TM" },
					{ exercise: "Incline DB Press", sets: 5, reps: 10 },
					{ exercise: "Chin-ups", sets: 5, reps: 10 },
				],
			},
			{
				day: "Day 2",
				focus: "Deadlift",
				lifts: [
					{ exercise: "Deadlift", sets: 1, reps: 5, weight: 345, note: "top set · 5+ AMRAP @ 85% TM" },
					{ exercise: "Front Squat", sets: 5, reps: 5, weight: 185 },
					{ exercise: "Hanging Leg Raise", sets: 5, reps: 15 },
				],
			},
			{
				day: "Day 3",
				focus: "Bench Press",
				lifts: [
					{ exercise: "Bench Press", sets: 1, reps: 5, weight: 190, note: "top set · 5+ AMRAP @ 85% TM" },
					{ exercise: "DB Row", sets: 5, reps: 10 },
					{ exercise: "Dips", sets: 5, reps: 15 },
				],
			},
			{
				day: "Day 4",
				focus: "Back Squat",
				lifts: [
					{ exercise: "Back Squat", sets: 1, reps: 5, weight: 270, note: "top set · 5+ AMRAP @ 85% TM" },
					{ exercise: "Romanian Deadlift", sets: 5, reps: 10, weight: 225 },
					{ exercise: "Ab Wheel", sets: 5, reps: 12 },
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
	actuals: string; // JSON
};

const COACH_SYSTEM = `You are liftty, a concise strength coach for one lifter.
You speak plainly, reference the lifter's real numbers, and never invent PRs.`;

export class LifttyAgent extends Agent<Env, State> {
	initialState = SEED_STATE;

	/** Runs on every wake (idempotent). Create history table; seed a pre-existing empty instance. */
	async onStart() {
		this.sql`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			date TEXT NOT NULL,
			status TEXT NOT NULL,
			prescribed TEXT NOT NULL DEFAULT '{}',
			actuals TEXT NOT NULL DEFAULT '{}'
		)`;

		// The "me" DO was created in M0 with the old empty state; initialState won't
		// retroactively apply. Seed once if the program is empty (safe: real edits set days).
		if (!this.state?.program?.days?.length) {
			this.setState(SEED_STATE);
		}
	}

	/** RPC: everything the /plan view needs, in one round-trip. */
	async getPlanData(): Promise<{ state: State; recentSessions: SessionRow[] }> {
		const recentSessions = this.sql<SessionRow>`
			SELECT * FROM sessions ORDER BY date DESC LIMIT 10`;
		return { state: this.state, recentSessions };
	}

	/** Chat round-trip (M0). POST { message } → coach reply. */
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
