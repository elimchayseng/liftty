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
	});

	return provider(env.MODEL);
}
