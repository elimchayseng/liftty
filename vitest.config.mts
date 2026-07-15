import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	// TEST-RUNTIME-ONLY FIX (Node + `wrangler deploy` prod are unaffected).
	//
	// `ai` and `@cloudflare/codemode` ship dual CJS/ESM builds. By default vitest-pool-workers
	// externalizes `ai` — letting workerd load its node_modules build directly — and workerd's
	// CJS→ESM interop can't surface `asSchema`/`tool`, which are getter re-exports from
	// `@ai-sdk/provider-utils` (`0 && (module.exports = { asSchema, ... })`). Since
	// `@cloudflare/codemode/dist/ai.js` does `import { asSchema, tool } from "ai"`, the whole suite
	// failed at load: "The requested module 'ai' does not provide an export named 'asSchema'".
	//
	// Inlining the AI SDK graph makes Vite transform it (instead of externalizing), flattening the
	// dual-build re-exports into clean, statically-linkable ESM named exports before workerd sees
	// them. `ssr.noExternal` (Vite) and `test.server.deps.inline` (Vitest) are the matched pair.
	ssr: {
		noExternal: ["ai", "@cloudflare/codemode", "@ai-sdk/provider-utils"],
	},
	test: {
		server: {
			deps: {
				inline: ["ai", "@cloudflare/codemode", "@ai-sdk/provider-utils"],
			},
		},
		poolOptions: {
			workers: {
				// The plugin tests drive the raw Worker Loader (dynamic isolates) through DO RPC, which
				// the per-test isolated-storage stacking can't tear down ("Isolated storage failed").
				// We isolate instead by giving each test its own DO name, so opt out of stacked storage.
				isolatedStorage: false,
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
	},
});
