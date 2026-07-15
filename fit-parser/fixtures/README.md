# `.fit` fixtures — source of truth for the M6 parser

The parser's field mapping is designed **from a real COROS strength `.fit` file**, not from
Garmin assumptions (plan M6, step 0). That file is a **human dependency**: it must be
exported from Ethan's COROS watch/app and committed here. Until it lands, the parser's
`_MAPPING_TODO` in `../server.py` is provisional and `test_parser.py` skips.

## What to commit

- **Filename:** `coros-strength.fit`
- A **strength session** (not a run) — ideally a few exercises with multiple sets each, so
  the dump shows the rep / weight / exercise fields clearly. Include at least one set where
  you entered a weight and, if easy, one where you didn't — that exercises the reps-only path.

## How to export it (COROS)

1. Do (or open) a strength workout on the COROS watch so it syncs to the COROS app.
2. In the COROS web dashboard / app, open that activity and use **Export → Original / `.fit`**
   (COROS exports native FIT; the app's "Export FIT File" option). If only the app has it,
   AirDrop / email the `.fit` to yourself.
3. Drop the file in this directory as `coros-strength.fit` and commit it.

> Do NOT fetch this via the COROS MCP / API in the build environment — the real export is a
> deliberate human step so the mapping is grounded in a genuine file, and to keep secrets and
> live account access out of the repo.

## After committing — finalize the mapping (5 min)

```bash
cd fit-parser
pip install -r requirements.txt
python dump_messages.py fixtures/coros-strength.fit            # overview: message types + fields
python dump_messages.py fixtures/coros-strength.fit --only set_mesgs   # raw set records
```

Read the `set_mesgs` records and update `_MAPPING_TODO` in `server.py` to the **real** field
names (rep field, weight field + unit, `set_type` active value, how the exercise is encoded).
Then run `python test_parser.py` — it now parses the fixture instead of skipping.

### If weight is absent from COROS sets

Expected quirk: COROS often stores per-set weight as absent / `0`. That is fine —
`parse_fit` emits **reps-only** sets (no `weight` key), the DO's `logSet` treats weight as
optional, and the Worker fills weight from the **prescribed program day** on ingest. Record
this design call in `FRICTION.md` (per the plan).
