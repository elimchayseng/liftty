# liftty

A single-user weightlifting coach as a **stateful agent** on Cloudflare Workers. Each user is one Durable Object (Agents SDK) that owns its state, its embedded SQLite history, and its rest-timer alarms. Inference goes out through **AI Gateway** to Heroku Managed Inference (`claude-opus-4-8`); a live workout session runs over **WebSocket** with hibernation.

See **[PLAN.md](./PLAN.md)** for the phased build, architecture diagrams, and doc-drift notes.

## Cloudflare products in play

| Product | Role |
|---|---|
| Workers | Runtime host + HTTP/WS router |
| Durable Objects (SQLite) | Per-user agent state, single-writer, alarms, hibernation |
| Agents SDK (`agents`) | Agent class over the DO |
| AI Gateway | Control plane in front of Heroku (logs, caching, spend caps, BYOK) |
| Dynamic Worker Loader | Code Mode sandbox (M3) |

## Status

- **M0 — scaffold + inference wiring:** ✅ deployed. Worker + DO + AI Gateway → Heroku chat round-trip.
- **M1 — agent state + `/plan`:** ✅ deployed. Seeded from real athlete data; mobile `/plan` view; state persists (seed-once).
- **M2 — typed `Training` tools:** ✅ the coach reads/mutates via 4 typed tools (`getProgram`, `getHistory`, `logSet`, `adjustProgram`) in a multi-step chat loop. "How's my squat trending?" reads history; "deload"/"set X to Y" mutates the program.

## Run it

```sh
npm install
# 1) Provision (see PLAN.md Phase 0): AI Gateway `liftty` + custom provider `heroku`
# 2) Put real values in wrangler.jsonc (CF_ACCOUNT_ID) and .dev.vars (HEROKU_INFERENCE_KEY)
npm run dev          # local: http://localhost:8787
# chat: POST /agents/liftty-agent/me  { "message": "..." }

wrangler secret put HEROKU_INFERENCE_KEY
npm run deploy
```
