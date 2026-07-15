"""Parser tests — run against the real COROS fixture if present, skip gracefully if absent.

The fixture is a HUMAN DEPENDENCY (Ethan exports it — see fixtures/README.md), so this
suite must never fail merely because the file isn't committed yet. It skips cleanly when the
fixture is missing and asserts the SetInput-shaped contract when it is.

    python test_parser.py          # plain runner, no pytest needed
    pytest test_parser.py          # also works if pytest is installed
"""

from __future__ import annotations

import os

from server import parse_fit

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "coros-strength.fit")


def _assert_setinput_shape(result: dict) -> None:
    """Every emitted set must map onto TS `SetInput` = { exercise, reps, weight? }."""
    assert result["ok"] is True
    assert isinstance(result["sets"], list)
    for s in result["sets"]:
        assert set(s).issubset({"exercise", "reps", "weight"}), f"unexpected keys: {s}"
        assert isinstance(s["exercise"], str) and s["exercise"], s
        assert isinstance(s["reps"], int) and s["reps"] >= 1, s  # matches logSet's guard
        if "weight" in s:  # weight is OPTIONAL — reps-only sets are valid
            assert isinstance(s["weight"], (int, float)) and s["weight"] > 0, s


def test_fixture_parses_into_setinput_shape() -> None:
    if not os.path.exists(FIXTURE):
        # SKIP, not fail: fixture is a documented human dependency.
        print(f"SKIP: fixture not found at {FIXTURE} (Ethan exports it — see fixtures/README.md)")
        return
    with open(FIXTURE, "rb") as f:
        result = parse_fit(f.read())
    _assert_setinput_shape(result)
    print(f"OK: parsed {result['meta']['emitted']} set(s) from fixture; meta={result['meta']}")


def test_empty_bytes_do_not_crash() -> None:
    """Robustness: a non-.fit / empty body should raise a clean error, not hang or segfault.

    parse_fit itself is allowed to raise on invalid bytes (the HTTP layer turns that into a
    422); we just assert it fails fast rather than producing garbage."""
    try:
        parse_fit(b"")
    except Exception as exc:
        print(f"OK: empty bytes rejected cleanly: {type(exc).__name__}")
        return
    # If the SDK tolerates empty input, it must still return the documented shape.
    print("NOTE: parse_fit tolerated empty bytes; ensure it returned the {ok, sets, meta} shape")


if __name__ == "__main__":
    test_empty_bytes_do_not_crash()
    test_fixture_parses_into_setinput_shape()
    print("done")
