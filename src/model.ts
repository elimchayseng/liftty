import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Inference path: Worker → AI Gateway (custom provider "heroku") → Heroku Managed Inference.
 *
 * The model is BYO (Heroku, existing billing, model `claude-opus-4-8`); AI Gateway is the
 * Cloudflare-native control plane in front of it (logs, caching, spend caps, swappable provider).
 *
 * URL shape (docs 2026-07): everything after `custom-{slug}/` is appended to the provider base_url,
 * so `/v1/chat/completions` lands on Heroku's OpenAI-compatible endpoint unchanged.
 *   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/custom-{slug}/v1
 *
 * Auth (two independent layers):
 *   - `Authorization: Bearer <HEROKU_INFERENCE_KEY>`  → upstream Heroku auth. For a CUSTOM provider
 *     the key is NOT stored in the gateway/BYOK; the Worker passes it per request. Set via
 *     `wrangler secret put HEROKU_INFERENCE_KEY`. Sent here via the provider's `apiKey`.
 *   - `cf-aig-authorization: Bearer <AIG_TOKEN>`      → Cloudflare gateway auth. OPTIONAL — only
 *     needed if you enable "Authenticated Gateway". Left unset for the demo (the Heroku key is the
 *     real gate). Set `AIG_TOKEN` later to harden.
 */
/** Recursively delete every `$schema` key in place. See shim reason (2) below. */
function stripSchemaKeys(value: unknown): void {
	if (Array.isArray(value)) {
		for (const v of value) stripSchemaKeys(v);
	} else if (value && typeof value === "object") {
		delete (value as Record<string, unknown>).$schema;
		for (const v of Object.values(value as Record<string, unknown>)) stripSchemaKeys(v);
	}
}

/**
 * Compat shim for Heroku's Anthropic-backed endpoint. Two fixes on the outgoing request body:
 *
 * (1) Every message must have NON-EMPTY content ("messages[N]: content is required"). The AI SDK
 *     emits empty/null content for assistant messages carrying only tool_calls (no preamble text);
 *     Anthropic also rejects whitespace-only text blocks. We substitute a minimal non-whitespace
 *     placeholder on those intermediate tool-turns (the user never sees them; the final reply is
 *     returned separately).
 *
 * (2) No `$schema` anywhere in tool parameter schemas ("unrecognized request argument: $schema").
 *     Our four training tools dodge this by hand-writing JSON Schema, but Code Mode's generated
 *     `codemode` tool (@cloudflare/codemode) builds its own StandardSchema that re-emits a top-level
 *     `$schema`. Rather than special-case one tool, strip `$schema` recursively — it is pure
 *     JSON-Schema dialect metadata and always safe to drop for Anthropic. Same root cause as the
 *     zod-v4 `$schema` friction from M2, now reintroduced by the Code Mode tool wrapper.
 */
const patchedFetch: typeof fetch = async (input, init) => {
	if (init?.body && typeof init.body === "string") {
		try {
			const body = JSON.parse(init.body);
			if (Array.isArray(body?.messages)) {
				for (const m of body.messages) {
					if (m && (m.content == null || m.content === "")) m.content = ".";
				}
			}
			// (3) Streaming requests must opt in to a final usage chunk, or the response carries NO token
			//     counts and AI Gateway logs 0 in / 0 out. The OpenAI-compatible flag for that is
			//     `stream_options.include_usage`, which the AI SDK does not send by default. We stream to
			//     dodge Heroku's non-streaming timeout, so we need this to keep the gateway measurement honest.
			if (body?.stream === true) {
				body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
			}
			stripSchemaKeys(body);
			init = { ...init, body: JSON.stringify(body) };
		} catch {
			/* not JSON — pass through untouched */
		}
	}
	return fetch(input, init);
};

/**
 * Optional per-flow measurement tag. When present, every model step in this flow rides a
 * `cf-aig-metadata` header carrying `{ run_id, mode }`, so the token-optimization harness can
 * group the flow's several gateway requests by `run_id` and sum input tokens. A fresh provider is
 * built per `onRequest`, so this static header is set once and correctly scoped to one flow.
 * Absent for normal chat — production traffic is byte-identical to before.
 */
export type RunTag = { runId: string; mode: "tools" | "codemode"; model?: string; variant?: string; decoys?: number };

export function getModel(env: Env, run?: RunTag) {
	const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY}/custom-${env.PROVIDER_SLUG}/v1`;
	// Measured runs may override the model (to compare batching/token cost across models); normal chat
	// uses the configured default.
	const modelId = run?.model || env.MODEL;

	const headers: Record<string, string> = {};
	if (env.AIG_TOKEN) {
		headers["cf-aig-authorization"] = `Bearer ${env.AIG_TOKEN}`;
	}
	if (run) {
		// AI Gateway metadata: JSON object, string values, filterable in the logs API. The experiment
		// axes (variant/decoys) are only included when defined, so an un-tagged run stays as before.
		const metadata: Record<string, string | number> = { run_id: run.runId, mode: run.mode, model: modelId };
		if (run.variant !== undefined) metadata.variant = run.variant;
		if (run.decoys !== undefined) metadata.decoys = run.decoys;
		headers["cf-aig-metadata"] = JSON.stringify(metadata);
	}

	const provider = createOpenAICompatible({
		name: "heroku-via-ai-gateway",
		baseURL,
		apiKey: env.HEROKU_INFERENCE_KEY, // → Authorization: Bearer <heroku key>
		headers,
		fetch: patchedFetch,
	});

	return provider(modelId);
}
