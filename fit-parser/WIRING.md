# WIRING.md — integrating the `.fit` container into liftty

**Status: SPEC, NOT APPLIED.** This milestone's strict scope is *new files under `fit-parser/`
only*. Every snippet below edits files another agent owns (`wrangler.jsonc`, `src/server.ts`,
`package.json`). They are copy-paste-ready for whoever wires M6 in — do **not** apply them from
this milestone.

The design invariant, stated once: **the container is a pure function.** It takes `.fit` bytes
and returns sets JSON. It performs no writes and never calls the model. Every write happens back
on the Durable Object via the *same typed `logSet` method* the chat and Code-Mode paths use —
identical trust design to the plugins. The container just replaces "model reads the chat" with
"parser reads the watch file" as the source of the sets.

---

## 1. Dependency + `wrangler.jsonc`

```bash
npm i @cloudflare/containers
```

The `Container` helper class ships in `@cloudflare/containers`; it is a Durable Object under the
hood, so it needs both a `containers` entry (image + the DO class that fronts it) **and** a
migration entry, exactly like `LifttyAgent`.

Add to `wrangler.jsonc` (merge into the existing objects — do not duplicate keys):

```jsonc
{
  // ...existing name / main / compatibility_date / worker_loaders / vars...

  "containers": [
    {
      "class_name": "FitParser",
      // Path to THIS milestone's Dockerfile, relative to the wrangler config (repo root).
      "image": "./fit-parser/Dockerfile",
      // Keep a single warm instance for the demo so the *first* upload shows a real cold
      // start and subsequent ones show warm — that contrast is the memo number.
      "max_instances": 1
    }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "LifttyAgent", "class_name": "LifttyAgent" },
      // The Container helper is DO-backed — bind the class that extends Container.
      { "name": "FIT_PARSER", "class_name": "FitParser" }
    ]
  },

  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["LifttyAgent"] },
    // New tag — Container DOs register as a plain new class.
    { "tag": "v2", "new_classes": ["FitParser"] }
  ]
}
```

---

## 2. `FitParser extends Container` (in `src/server.ts`, exported)

```ts
import { Container, getContainer } from "@cloudflare/containers";

/**
 * DO-backed wrapper around the Python `.fit` parser container (fit-parser/Dockerfile).
 * Pure function: forwards raw bytes to the container's POST /parse and returns the JSON.
 * No writes here — all persistence stays on the LifttyAgent DO (see the route below).
 */
export class FitParser extends Container<Env> {
  // Must match ENV PORT / EXPOSE in fit-parser/Dockerfile (server.py listens on 8080).
  defaultPort = 8080;
  // Let it nap between uploads so cold-start is a real, measurable event in the demo.
  sleepAfter = "2m";
}
```

`Env` must include the binding; the generated `worker-configuration.d.ts` picks it up after
`wrangler types`, or add `FIT_PARSER: DurableObjectNamespace<FitParser>` to the `Env` type.

---

## 3. Worker route `POST /upload-fit` (in the `export default { fetch }` block)

Insert alongside the existing routes in `src/server.ts` (before the `routeAgentRequest`
fallthrough). This is the whole flow: forward bytes → container → parsed sets → DO writes.

```ts
if (url.pathname === "/upload-fit" && request.method === "POST") {
  // 1. Raw .fit bytes straight from the watch export (multipart optional; raw body is simplest).
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return new Response("empty body; POST raw .fit bytes", { status: 400 });

  // 2. PURE FUNCTION in the container. getContainer routes to the single warm instance.
  //    *** COLD-START MEASUREMENT POINT — see §5. ***
  const container = getContainer(env.FIT_PARSER);
  const parseRes = await container.fetch("http://parser/parse", {
    method: "POST",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
  });
  const parsed = (await parseRes.json()) as {
    ok: boolean;
    sets: { exercise: string; reps: number; weight?: number }[];
    meta: unknown;
  };
  if (!parsed.ok) return Response.json(parsed, { status: 422 });

  // 3. ALL WRITES ON THE VALIDATED DO PATH — same typed methods as chat / Code Mode.
  const me = await getAgentByName(env.LifttyAgent, "me");
  const result = await me.ingestFitSession(parsed.sets); // small new DO method, see §4
  return Response.json({ ok: true, ...result, meta: parsed.meta });
}
```

---

## 4. The DO side — one small typed method (in `class LifttyAgent`)

`logSet` today accumulates into `state.activeSession` (a hot buffer); the seed/reseed path is
what writes completed rows into the `sessions` SQLite table. The plan asks for *"insert a
completed `sessions` row + `logSet` loop through the same typed methods."* Add one method that
does exactly that so the route stays thin and every write is validated in one place:

```ts
/** Ingest parsed .fit sets: loop the typed logSet, then commit a completed session row.
 *  Weight is optional — reps-only sets (COROS often omits weight) are matched to the
 *  prescribed program day here, keeping the container a pure, weight-agnostic function. */
ingestFitSession(sets: SetInput[]): { logged: number; sessionId: string } {
  // Optional: fill missing weights from today's prescribed lifts before logging.
  const day = this.state.program.days[/* today */ 0];
  for (const s of sets) {
    const filled =
      s.weight == null
        ? { ...s, weight: day?.lifts.find((l) => l.exercise.toLowerCase().includes(s.exercise.toLowerCase()))?.weight }
        : s;
    this.logSet(filled); // <-- same typed method, same runtime validation (reps int, weight finite)
  }
  // Commit the buffered activeSession as a completed sessions row (mirror seedSessions()).
  const active = this.state.activeSession;
  const id = `fit-${Date.now()}`;
  const actuals = JSON.stringify({
    focus: active?.day ?? "Session",
    summary: `Imported ${sets.length} set(s) from COROS .fit`,
    day: active?.day,
  });
  this.sql`INSERT INTO sessions (id, date, status, prescribed, actuals)
    VALUES (${id}, ${new Date().toISOString().slice(0, 10)}, ${"completed"}, ${"{}"}, ${actuals})`;
  this.setState({ ...this.state, activeSession: null });
  return { logged: sets.length, sessionId: id };
}
```

> Weight-matching is best-effort and lives on the DO (the validated side), never in the
> container. If a lift name doesn't match, the set logs reps-only — `logSet` already allows it.

---

## 5. Where to measure cold-start vs isolate spin-up (the headline memo number)

This is the empirical grounding for "isolates make per-user policy cardinality viable." Measure
**wall time across the awaited I/O boundary** — Workers freezes `Date.now()` during CPU work, so
CPU-internal timing lies; time the `await` on the container/isolate call instead (note this
caveat in `RUNTIME-NOTES.md`).

- **Container cold start** — wrap the `await container.fetch(...)` in §3:
  ```ts
  const t0 = Date.now();
  const parseRes = await container.fetch("http://parser/parse", { /* ... */ });
  console.log("fit-container ms", Date.now() - t0, "(cold on first upload after sleep)");
  ```
  Read it from **prod** `wrangler tail` (not `wrangler dev` — M3 taught that dev hides prod
  gating). First upload after `sleepAfter` = cold (expect seconds); a second immediately after =
  warm (expect tens of ms). Report both.

- **Isolate spin-up** — the plugin/Code-Mode path already times `LOADER.get()` cold-load vs
  cached `get()` in M3; put both numbers in the same `RUNTIME-NOTES.md` table. The contrast
  (isolate ms vs container seconds, on the same app, same trust design) is the whole M6 point.

---

## 6. Local dev loop (Docker required)

```bash
# Build + smoke-test the container in isolation, no Cloudflare needed:
cd fit-parser
docker build -t fit-parser .
docker run --rm -p 8080:8080 fit-parser
curl -s --data-binary @fixtures/coros-strength.fit \
  -H 'content-type: application/octet-stream' http://localhost:8080/parse | jq

# End-to-end via Wrangler (needs Docker running + a container-enabled account for deploy):
npx wrangler dev        # builds the image from ./fit-parser/Dockerfile
curl -s --data-binary @fit-parser/fixtures/coros-strength.fit http://localhost:8787/upload-fit | jq
```

Deploy: `npx wrangler deploy` (requires a Workers plan with Containers enabled). If the build
environment can't run Docker, everything above ships as code + this spec for Ethan to deploy.
