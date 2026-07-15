"""M6 container contrast — Python `.fit` strength-set parser + minimal HTTP server.

Role in the demo (framing correction #3): this is *workload placement*, not agent
authorship. The parser is HAND-WRITTEN and the model is NEVER involved at execution time.
It runs in a Cloudflare Container purely because binary `.fit` parsing needs a full Python
environment + FIT decoding libs, which cannot live in a V8 isolate. Same trust design as the
plugins: a PURE FUNCTION (bytes in → JSON out), no writes, no model, no outbound calls. All
persistence happens later, back on the validated Durable Object path (see WIRING.md).

Output shape maps 1:1 onto the TypeScript `SetInput` type in `src/training.ts`:
    { exercise: string, reps: number, weight?: number }   // weight optional (lb)
so the Worker can loop the parsed sets straight through the DO's typed `logSet` method.

    POST /parse   raw .fit bytes (application/octet-stream)  ->  { ok, sets, meta }
    GET  /health  liveness probe

────────────────────────────────────────────────────────────────────────────────────────
FIELD MAPPING IS A TODO KEYED TO THE REAL COROS DUMP  (plan step 0)
────────────────────────────────────────────────────────────────────────────────────────
The real COROS strength `.fit` fixture does not exist in-repo yet — Ethan must export one
(see fixtures/README.md) and run `dump_messages.py` on it. The constants in
`_MAPPING_TODO` below are our BEST GUESS from the FIT Global Profile's strength `set`
message; every one is provisional until the dump confirms the actual COROS field names.
COROS strength quirks we are designing defensively around:
  - rep counts are auto-detected by the watch  -> usually present as `repetitions`
  - per-set weight is often ABSENT or user-entered -> we emit reps-only sets when missing;
    the Worker matches weight from the prescribed program day (logSet treats weight optional)
  - muscle-group / exercise tags vary -> exercise name derivation is a labelled TODO
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from typing import Any

# ── Provisional field mapping — FINALIZE FROM `dump_messages.py` OUTPUT ON THE REAL FILE ──
_MAPPING_TODO = {
    # The FIT message that carries one strength set. Global profile name: "set" (num 225).
    # garmin-fit-sdk exposes decoded messages keyed by "<name>_mesgs".
    "set_message_key": "set_mesgs",
    # Field that distinguishes a working set from an inter-set rest. Profile enum `set_type`:
    # 0 = rest, 1 = active. TODO: confirm COROS actually populates this; if not, we keep all.
    "set_type_field": "set_type",
    "set_type_active_values": {1, "active"},
    # Rep count. TODO: confirm COROS uses `repetitions` (some devices use `reps`).
    "reps_field": "repetitions",
    # Per-set weight (may be absent on COROS). TODO: confirm field name + unit.
    "weight_field": "weight",
    # Weight unit: FIT weight is conventionally kg. SetInput weight is LB. TODO: confirm
    # whether COROS stores kg (convert) or already user's display unit. Flip when dump says so.
    "weight_is_kg": True,
    # Exercise name derivation. FIT encodes exercise as category + subtype enums, or a
    # developer/`exercise_title` string. TODO: read the dump and map to readable names.
    "exercise_name_field": "exercise_name",       # sometimes a decoded string
    "exercise_category_field": "category",         # enum / list fallback
}

_KG_TO_LB = 2.20462262


def _first(d: dict, *keys: str) -> Any:
    """Return the first present, non-None value among keys (defensive against name drift)."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def _derive_exercise(msg: dict) -> str:
    """Best-effort readable exercise name. TODO: finalize from the COROS dump.

    FIT gives us some combination of a decoded `exercise_name` string, a `category` enum,
    and a `category_subtype`. Until we see the real values we fall back gracefully so the
    parser never crashes on an unmapped exercise — a reps-only set with a generic label is
    still loggable, and the Worker matches it to the prescribed program day by position."""
    name = _first(msg, _MAPPING_TODO["exercise_name_field"], "exercise_title", "name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    cat = _first(msg, _MAPPING_TODO["exercise_category_field"], "category_subtype")
    if cat is not None:
        # Lists come through for multi-category sets; join for a readable-ish tag.
        if isinstance(cat, (list, tuple)):
            cat = "/".join(str(c) for c in cat if c is not None)
        return str(cat).replace("_", " ").strip() or "exercise"
    return "exercise"  # unmapped — still a valid reps-only set for logSet


def _is_active_set(msg: dict) -> bool:
    st = msg.get(_MAPPING_TODO["set_type_field"])
    if st is None:
        return True  # COROS may omit set_type; keep the set rather than silently drop it
    return st in _MAPPING_TODO["set_type_active_values"]


def _to_lb(weight: Any) -> float | None:
    """Normalize a FIT weight to pounds (SetInput unit). TODO: confirm source unit vs dump."""
    if weight is None:
        return None
    try:
        w = float(weight)
    except (TypeError, ValueError):
        return None
    if w <= 0:
        return None  # COROS often stores 0 / sentinel when weight was not entered → reps-only
    if _MAPPING_TODO["weight_is_kg"]:
        w = w * _KG_TO_LB
    return round(w, 1)


def parse_fit(data: bytes) -> dict:
    """PURE FUNCTION: raw `.fit` bytes → strength sets shaped for SetInput[].

    Returns { ok, sets, meta }. `sets` is a list of { exercise, reps, weight? } dicts; a set
    with no usable weight is emitted reps-only (weight key omitted), which the DO's logSet
    accepts. Never raises on malformed strength fields — it skips what it can't read and
    reports counts in `meta` so the caller can see how much was recognised."""
    # Import here so the module is importable (for tests) even if the SDK isn't installed,
    # and so `dump_messages.py` / tests give a clear message rather than an import-time crash.
    from garmin_fit_sdk import Decoder, Stream  # type: ignore

    stream = Stream.from_byte_array(bytearray(data))
    decoder = Decoder(stream)
    messages, errors = decoder.read()

    set_msgs = messages.get(_MAPPING_TODO["set_message_key"], []) or []
    sets: list[dict] = []
    skipped_rest = 0
    reps_only = 0

    for msg in set_msgs:
        if not _is_active_set(msg):
            skipped_rest += 1
            continue
        reps = _first(msg, _MAPPING_TODO["reps_field"], "reps")
        try:
            reps = int(reps)
        except (TypeError, ValueError):
            continue  # a working set with no rep count isn't loggable; skip defensively
        if reps < 1:
            continue

        out: dict[str, Any] = {"exercise": _derive_exercise(msg), "reps": reps}
        weight_lb = _to_lb(_first(msg, _MAPPING_TODO["weight_field"]))
        if weight_lb is not None:
            out["weight"] = weight_lb
        else:
            reps_only += 1
        sets.append(out)

    return {
        "ok": True,
        "sets": sets,
        "meta": {
            "setMessages": len(set_msgs),
            "emitted": len(sets),
            "skippedRest": skipped_rest,
            "repsOnly": reps_only,  # weight absent → Worker matches from prescribed day
            "decoderErrors": [str(e) for e in (errors or [])],
            # Loud reminder that the mapping is provisional until the dump confirms it.
            "mappingStatus": "PROVISIONAL — finalize _MAPPING_TODO from dump_messages.py on the real COROS fixture",
        },
    }


class _Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "fit-parser"})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/parse":
            self._json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        data = self.rfile.read(length) if length else b""
        if not data:
            self._json(400, {"ok": False, "error": "empty body; POST raw .fit bytes"})
            return
        try:
            self._json(200, parse_fit(data))
        except Exception as exc:  # never leak a stack to the caller; report cleanly
            self._json(422, {"ok": False, "error": f"could not parse .fit: {exc}"})

    def log_message(self, *args: Any) -> None:  # keep container stdout clean
        return


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    print(f"fit-parser listening on :{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
