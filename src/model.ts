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
/**
 * Compat shim: Heroku's Anthropic-backed endpoint requires every message to have NON-EMPTY
 * content ("messages[N]: content is required"). The AI SDK emits empty/null content for assistant
 * messages that carry only tool_calls (no preamble text). Anthropic also rejects whitespace-only
 * text blocks, so we substitute a minimal non-whitespace placeholder. This message is an
 * intermediate tool-turn the user never sees (the final reply is returned separately).
 */
const patchedFetch: typeof fetch = async (input, init) => {
	if (init?.body && typeof init.body === "string") {
		try {
			const body = JSON.parse(init.body);
			if (Array.isArray(body?.messages)) {
				for (const m of body.messages) {
					if (m && (m.content == null || m.content === "")) m.content = ".";
				}
				init = { ...init, body: JSON.stringify(body) };
			}
		} catch {
			/* not JSON — pass through untouched */
		}
	}
	return fetch(input, init);
};

export function getModel(env: Env) {
	const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY}/custom-${env.PROVIDER_SLUG}/v1`;

	const headers: Record<string, string> = {};
	if (env.AIG_TOKEN) {
		headers["cf-aig-authorization"] = `Bearer ${env.AIG_TOKEN}`;
	}

	const provider = createOpenAICompatible({
		name: "heroku-via-ai-gateway",
		baseURL,
		apiKey: env.HEROKU_INFERENCE_KEY, // → Authorization: Bearer <heroku key>
		headers,
		fetch: patchedFetch,
	});

	return provider(env.MODEL);
}
