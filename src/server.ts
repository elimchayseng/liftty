import { Agent, routeAgentRequest } from "agents";
import { generateText } from "ai";
import { getModel } from "./model";

/**
 * liftty — a stateful lifting coach.
 *
 * One `LifttyAgent` = one Durable Object per user (routed by name; single-user demo seeds id "me").
 * State split (fleshed out in M1/M2):
 *   - Agent state (setState): lifter · program · activeSession  → hot, auto-persisted, WS-broadcast
 *   - Embedded SQLite (this.sql): sessions → append-only history
 *
 * M0 scope: the agent exists as a DO and chat round-trips to Heroku through the AI Gateway.
 */

// --- State shape (seeded in M1; declared now so the class type is stable) ---
export type PrescribedDay = {
	day: string;
	focus: string;
	lifts: { exercise: string; sets: number; reps: number; weight?: number }[];
};

export type State = {
	lifter: {
		prs: Record<string, number>;
		trainingMaxes: Record<string, number>;
		bodyweight?: number;
		injuries?: string[];
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

const INITIAL_STATE: State = {
	lifter: { prs: {}, trainingMaxes: {}, injuries: [] },
	program: { phase: "unset", goal: "unset", weekIndex: 0, days: [] },
	activeSession: null,
};

const COACH_SYSTEM = `You are liftty, a concise strength coach for one lifter.
You speak plainly, reference the lifter's real numbers, and never invent PRs.
In M0 you have no tools yet — just answer coaching questions directly.`;

export class LifttyAgent extends Agent<Env, State> {
	initialState = INITIAL_STATE;

	/**
	 * Chat round-trip (M0). POST { message } → coach reply.
	 * Reached via routeAgentRequest at /agents/liftty-agent/:name (e.g. /agents/liftty-agent/me).
	 */
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

		// Server-rendered views land in M1 (/plan) and M4 (/session). Placeholder for now.
		if (url.pathname === "/" || url.pathname === "/plan") {
			return new Response(
				"liftty — M0 up. Chat: POST /agents/liftty-agent/me { message }",
				{ headers: { "content-type": "text/plain" } },
			);
		}

		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<Env>;
