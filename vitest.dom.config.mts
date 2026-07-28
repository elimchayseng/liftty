import { defineConfig } from "vitest/config";

/**
 * A SECOND vitest project, deliberately separate from vitest.config.mts.
 *
 * The main suite runs inside workerd (@cloudflare/vitest-pool-workers) so tests can drive real
 * Durable Objects — but workerd has no DOM and no `eval`, and the /session client is ~500 lines of
 * ES5 living inside a template literal. That logic is where the reported bugs were, so it needs a
 * DOM to be testable at all. Keeping it in its own config leaves the carefully-tuned workers config
 * (module inlining, isolated storage, bindings) untouched.
 */
export default defineConfig({
	test: {
		name: "dom",
		environment: "jsdom",
		include: ["test/dom/**/*.spec.ts"],
		setupFiles: ["test/dom/setup.ts"],
		// localStorage needs a real origin — jsdom's default `about:blank` is opaque, so the API is
		// present but inert, and the draft/outbox layers this suite exists to test would silently no-op.
		environmentOptions: { jsdom: { url: "http://localhost/session" } },
	},
});
