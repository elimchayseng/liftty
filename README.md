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

- **M0 — scaffold + inference wiring:** ✅ code complete. Worker boots, DO binding + chat endpoint wired, request reaches AI Gateway. Blocked on Phase 0 creds for a live round-trip.

## Run it

```sh
npm install
# 1) Provision (see PLAN.md Phase 0): Workers Paid, AI Gateway `liftty` + custom provider `heroku` + BYOK
# 2) Put real values in wrangler.jsonc (CF_ACCOUNT_ID) and .dev.vars (AIG_TOKEN)
npm run dev          # local: http://localhost:8787
# chat: POST /agents/liftty-agent/me  { "message": "..." }

wrangler secret put AIG_TOKEN
npm run deploy
```
