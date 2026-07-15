import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { buildTrainingTools, type Training, type PluginAuthoring } from "./training";

/**
 * Code Mode (M3) — the same four typed Training methods, one tool.
 *
 * In M2 the coach got four AI SDK tools and called them one at a time; a 3-step request
 * ("log my squats, did I PR, bump next week if so") was three tool round-trips, each result
 * re-entering the model's context. Here the coach gets ONE tool — `codemode` — and writes a
 * single async JS snippet against the typed API:
 *
 *     async () => {
 *       const h = await training.getHistory("squat");
 *       await training.logSet({ exercise: "Front Squat", reps: 8, weight: 225 });
 *       if (top > tm) await training.adjustProgram({ op: "setExerciseWeight", ... });
 *       return { pr, newTM };
 *     }
 *
 * How it runs (all Cloudflare-native, no host creds leave the DO):
 *   - `DynamicWorkerExecutor` loads the snippet into a **Dynamic Worker Loader** sandbox.
 *   - `globalOutbound: null` → the sandbox has NO network: `fetch()`/`connect()` throw. It can
 *     ONLY reach the four methods we hand it.
 *   - Each `training.*()` call in the sandbox dispatches back to THIS Durable Object over
 *     Workers RPC, where it runs `getProgram()`/`logSet()`/… against live `this.state` + `this.sql`.
 *   - Only the snippet's return value re-enters the model's context — not each intermediate call.
 *
 * The typed interface is identical to M2 (`buildTrainingTools`); only the execution path changes.
 * That's the whole point of the design — and why the M2 fallback is a one-line swap.
 */
export function buildCodeModeTool(agent: Training & PluginAuthoring, loader: WorkerLoader, opts?: { decoys?: number }) {
	const executor = new DynamicWorkerExecutor({
		loader,
		globalOutbound: null, // no network in the sandbox — capability-scoped to the four tools
		timeout: 20_000,
	});

	// Namespace the tools as `training.*` in the sandbox (default would be `codemode.*`).
	// Sandbox-facing TypeScript types are auto-generated from each tool's jsonSchema() wrapper.
	// `opts.decoys` (token-measurement study) appends N realistic no-op tools to the same object, so
	// each adds a `training.*` type-block line to the generated sandbox typings.
	const codemode = createCodeTool({
		tools: [{ name: "training", tools: buildTrainingTools(agent, { decoys: opts?.decoys }) }],
		executor,
	});

	return { codemode };
}
