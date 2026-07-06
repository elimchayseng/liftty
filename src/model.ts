import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Inference path: Worker → AI Gateway (custom provider "heroku", BYOK) → Heroku Managed Inference.
 *
 * The model is BYO (Heroku, existing billing, model `claude-opus-4-8`); AI Gateway is the
 * Cloudflare-native control plane in front of it (logs, caching, spend caps, swappable provider).
 *
 * URL shape (docs 2026-07): everything after `custom-{slug}/` is appended to the provider base_url,
 * so `/v1/chat/completions` lands on Heroku's OpenAI-compatible endpoint unchanged.
 *   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/custom-{slug}/v1
 *
 * Auth: `cf-aig-authorization: Bearer <AIG_TOKEN>` is the gateway auth token. With BYOK configured,
 * the gateway injects the Heroku INFERENCE_KEY server-side — it never touches Worker code.
 */
export function getModel(env: Env) {
	const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY}/custom-${env.PROVIDER_SLUG}/v1`;

	const provider = createOpenAICompatible({
		name: "heroku-via-ai-gateway",
		baseURL,
		headers: {
			"cf-aig-authorization": `Bearer ${env.AIG_TOKEN}`,
		},
	});

	return provider(env.MODEL);
}
