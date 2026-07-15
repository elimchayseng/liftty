"""Dump every FIT message + field name from a `.fit` file — the plan's step 0 tool.

Run this on the REAL COROS strength export to see which set / rep / weight / exercise
fields actually exist, then finalize `_MAPPING_TODO` in `server.py` from what you see.
The parser's field mapping is designed FROM this dump, not from Garmin assumptions.

    python dump_messages.py fixtures/coros-strength.fit
    python dump_messages.py fixtures/coros-strength.fit --only set_mesgs
    python dump_messages.py fixtures/coros-strength.fit --json > dump.json

What to look for (and copy into server.py's _MAPPING_TODO):
  1. The strength message key — expect "set_mesgs". Note its exact name here.
  2. Inside a set message: the rep field ("repetitions"?), weight field ("weight"?),
     the set_type field + its value for a working vs rest set, and how the exercise is
     encoded (a decoded `exercise_name` string? a `category` enum? `category_subtype`?).
  3. Whether weight is present at all, and its unit (kg vs the user's display unit).
     If weight is absent/zero across sets, that CONFIRMS the reps-only design call — the
     Worker matches weights from the prescribed program day (documented in FRICTION.md).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter


def load(path: str):
    from garmin_fit_sdk import Decoder, Stream  # imported lazily for a clean error message

    with open(path, "rb") as f:
        stream = Stream.from_byte_array(bytearray(f.read()))
    messages, errors = Decoder(stream).read()
    return messages, errors


def main() -> int:
    ap = argparse.ArgumentParser(description="Dump FIT message/field names from a .fit file.")
    ap.add_argument("path", help="path to a .fit file (e.g. fixtures/coros-strength.fit)")
    ap.add_argument("--only", help="dump full records for just this message key, e.g. set_mesgs")
    ap.add_argument("--json", action="store_true", help="emit the raw decoded messages as JSON")
    args = ap.parse_args()

    try:
        messages, errors = load(args.path)
    except FileNotFoundError:
        print(f"file not found: {args.path}", file=sys.stderr)
        return 1
    except ModuleNotFoundError:
        print("garmin-fit-sdk not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(messages, indent=2, default=str))
        return 0

    if args.only:
        records = messages.get(args.only, [])
        print(f"# {args.only}: {len(records)} record(s)\n")
        for i, rec in enumerate(records):
            print(f"--- {args.only}[{i}] ---")
            for k, v in rec.items():
                print(f"  {k}: {v!r}")
            print()
        return 0

    # Overview: every message type, how many of each, and the union of field names seen.
    print(f"# {args.path}")
    if errors:
        print(f"# decoder errors: {[str(e) for e in errors]}")
    print(f"# message types: {len(messages)}\n")
    for key in sorted(messages):
        records = messages[key] or []
        field_counts: Counter[str] = Counter()
        for rec in records:
            field_counts.update(rec.keys())
        fields = ", ".join(sorted(field_counts))
        marker = "  <-- strength sets? map this in server.py" if "set" in key else ""
        print(f"{key}: {len(records)} record(s){marker}")
        print(f"    fields: {fields}\n")

    print("Next: `python dump_messages.py <file> --only set_mesgs` to see raw set records,")
    print("then finalize _MAPPING_TODO in server.py from the real field names above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
