import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// M0 smoke test: the Worker boots and /plan is reachable. The chat endpoint needs
// live AI Gateway creds (Phase 0), so it's not asserted here.
describe("liftty worker (M0)", () => {
	it("serves the /plan placeholder", async () => {
		const response = await SELF.fetch("https://example.com/plan");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("liftty");
	});

	it("404s unknown routes", async () => {
		const response = await SELF.fetch("https://example.com/nope");
		expect(response.status).toBe(404);
	});
});

// M4: the live workout session page renders and wires a raw WS to the agent.
describe("liftty /session (M4)", () => {
	it("serves the /session page with the live-session markup", async () => {
		const response = await SELF.fetch("https://example.com/session");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("liftty");
		expect(html).toContain("session");
		// The page must open a raw WS to the agent and speak the log_set protocol.
		expect(html).toContain("/agents/liftty-agent/me");
		expect(html).toContain("log_set");
		expect(html).toContain("Receipts");
	});
});
