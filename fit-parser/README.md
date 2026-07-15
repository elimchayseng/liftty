# fit-parser — M6 container contrast

A hand-written Python `.fit` parser that runs in a **Cloudflare Container**. It takes raw
`.fit` bytes from Ethan's COROS watch (a **strength** session) and returns the completed sets
as JSON shaped for liftty's `SetInput` type, so the Worker can log them through the Durable
Object's typed `logSet` — the exact path chat and Code Mode already use.

## Why a container, not an isolate (the one-paragraph rationale)

liftty runs two agent-adjacent workloads and places each on the runtime its *requirements*
demand — that's the honest isolate-vs-container contrast, not a staged one. The training-policy
**plugins** are pure JS logic, so they live in a V8 **isolate**: millisecond startup, ~free,
per-user cardinality that's economically viable. Binary `.fit` parsing needs a full CPython
environment plus a FIT decoding library, which **cannot** run in a V8 isolate — so this
workload is forced onto a **container**: seconds of cold start, real cost. Same trust design
(pure function in, all writes back on the validated DO path), different runtime, measured
contrast. Neither workload touches the model at execution time — the parser is hand-written and
the model is not involved (framing correction #3); the split is purely about *where the code can
physically run*, and that difference is the headline number in the runtime memo.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | `python:3.12-slim` + the FIT SDK; runs `server.py`. |
| `requirements.txt` | `garmin-fit-sdk` (official SDK — justified in the file's comment). |
| `server.py` | Pure `parse_fit(bytes) -> {ok, sets, meta}` + a stdlib `POST /parse` server. No writes, no model. |
| `dump_messages.py` | Dumps all FIT message/field names — run on the real fixture to finalize the mapping. |
| `test_parser.py` | Parses the fixture if present; **skips gracefully** if absent. |
| `fixtures/README.md` | How Ethan exports + commits the COROS strength `.fit` (source of truth). |
| `WIRING.md` | Integration spec (NOT applied): `wrangler.jsonc` + `FitParser extends Container` + `POST /upload-fit` + where to measure cold start. |

## Build & run locally (Docker required)

```bash
cd fit-parser
docker build -t fit-parser .
docker run --rm -p 8080:8080 fit-parser
# then, once the COROS fixture exists:
curl -s --data-binary @fixtures/coros-strength.fit \
  -H 'content-type: application/octet-stream' http://localhost:8080/parse | jq
```

Without Docker, run the parser directly:

```bash
cd fit-parser
pip install -r requirements.txt
python dump_messages.py fixtures/coros-strength.fit   # inspect fields (needs the fixture)
python test_parser.py                                  # tests (skips if no fixture)
```

## Human dependencies (block full completion — by design)

1. **The COROS `.fit` fixture doesn't exist in-repo.** Ethan must export a real COROS
   strength-workout `.fit` to `fixtures/coros-strength.fit` (see `fixtures/README.md`). The
   field mapping (`_MAPPING_TODO` in `server.py`) is **provisional** until it's finalized from a
   `dump_messages.py` dump of that real file — do NOT fetch it via API/MCP; the export is a
   deliberate human step. **COROS strength quirks designed around:** rep counts are
   auto-detected (usually present); per-set weight is often absent/user-entered (we emit
   reps-only sets and the DO fills weight from the prescribed day); muscle-group / exercise tags
   vary (exercise-name derivation is a labelled TODO).
2. **Docker + a container-enabled Cloudflare account** are required to build/run/deploy the
   container. If the environment can't build Docker, ship this code + `WIRING.md`'s documented
   deploy step for Ethan.

## To finish M6

1. Ethan commits the fixture; run `dump_messages.py`; finalize `_MAPPING_TODO` in `server.py`.
2. Apply `WIRING.md` into `wrangler.jsonc` + `src/server.ts` (owned by other agents/PRs).
3. `wrangler dev` / `deploy`; measure container cold-start vs isolate spin-up (WIRING §5) into
   `RUNTIME-NOTES.md`; note the reps-only weight-matching design call in `FRICTION.md`.
