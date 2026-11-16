# app/tests/test_concurrency_locks.py
"""Reliability pass: direct, low-level tests of idempotency_lock()/
read_lock()'s actual flock semantics — independent of any particular
business function, so a future change to the lock primitives itself
gets caught here rather than only inferred from higher-level tests.

Verifies, with real OS threads (not asyncio.gather — see this series'
other concurrency tests for why that wouldn't exercise a real race):
multiple shared (read) holders never block each other; shared and
exclusive correctly exclude each other in both directions; nested
same-thread reentrancy is safe for every non-upgrading combination; and
a shared -> exclusive upgrade attempt is refused rather than silently
mishandled.
"""
import threading
import time

import pytest

from app.tools.idempotency_tools import idempotency_lock, read_lock


@read_lock()
def _hold_shared(duration: float, log: list, label: str) -> None:
    log.append((label, "acquired", time.monotonic()))
    time.sleep(duration)
    log.append((label, "released", time.monotonic()))


@idempotency_lock()
def _hold_exclusive(duration: float, log: list, label: str) -> None:
    log.append((label, "acquired", time.monotonic()))
    time.sleep(duration)
    log.append((label, "released", time.monotonic()))


def test_two_shared_holders_do_not_block_each_other():
    log: list = []
    t1 = threading.Thread(target=_hold_shared, args=(0.3, log, "A"))
    t2 = threading.Thread(target=_hold_shared, args=(0.3, log, "B"))

    start = time.monotonic()
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    total = time.monotonic() - start

    # If they blocked each other, this would take ~0.6s (serialized);
    # concurrent shared holders should finish in ~0.3s.
    assert total < 0.5, f"two shared holders took {total:.2f}s — they blocked each other"


def test_exclusive_waits_for_a_held_shared_lock_to_release():
    log: list = []

    def holder():
        _hold_shared(0.4, log, "reader")

    t = threading.Thread(target=holder)
    t.start()
    time.sleep(0.05)  # let the reader actually acquire first

    t0 = time.monotonic()
    _hold_exclusive(0.0, log, "writer")
    waited = time.monotonic() - t0
    t.join()

    assert waited > 0.25, f"exclusive acquired after only {waited:.2f}s — did not wait for the held shared lock"


def test_shared_waits_for_a_held_exclusive_lock_to_release():
    log: list = []

    def holder():
        _hold_exclusive(0.4, log, "writer")

    t = threading.Thread(target=holder)
    t.start()
    time.sleep(0.05)

    t0 = time.monotonic()
    _hold_shared(0.0, log, "reader")
    waited = time.monotonic() - t0
    t.join()

    assert waited > 0.25, f"shared acquired after only {waited:.2f}s — did not wait for the held exclusive lock"


def test_nested_shared_inside_shared_is_a_safe_passthrough():
    @read_lock()
    def outer():
        _hold_shared(0.0, [], "nested")
        return "ok"

    assert outer() == "ok"


def test_nested_shared_inside_exclusive_is_a_safe_passthrough():
    # The real pattern this exists for: resolve_financial_approval
    # (exclusive) calling find_financial_adjustment (would be shared) —
    # exclusive already excludes everyone, so the nested shared call
    # must pass through rather than deadlock on its own fd.
    @idempotency_lock()
    def outer():
        _hold_shared(0.0, [], "nested-in-exclusive")
        return "ok"

    assert outer() == "ok"


def test_nested_exclusive_inside_exclusive_is_still_a_safe_passthrough():
    @idempotency_lock()
    def outer():
        _hold_exclusive(0.0, [], "nested-exclusive")
        return "ok"

    assert outer() == "ok"


def test_shared_to_exclusive_upgrade_within_the_same_thread_is_refused():
    @read_lock()
    def outer():
        _hold_exclusive(0.0, [], "upgrade-attempt")

    with pytest.raises(RuntimeError, match="lock upgrade is not supported"):
        outer()


def test_exception_inside_shared_lock_still_releases_it():
    @read_lock()
    def flaky():
        raise ValueError("simulated failure while holding the shared lock")

    with pytest.raises(ValueError):
        flaky()

    # If the shared lock were left held, this would hang.
    result = []
    _hold_exclusive(0.0, result, "after-exception")
    assert result and result[0][1] == "acquired"
