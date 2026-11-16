# app/tools/idempotency_tools.py
import contextlib
import datetime
import fcntl
import json
import os
import threading
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

IDEMPOTENCY_HEADERS = ["idempotency_key", "operation", "result", "created_at"]

# Cross-PROCESS lock (independent-audit P1 fix). get_idempotent_result/
# record_idempotent_result below do an unsynchronized check-then-write
# against mock_erp.xlsx — on their own, two concurrent calls for the same
# idempotency_key can both see "no cached result" and both execute the
# real operation, defeating the whole point of the key. Worse: openpyxl's
# load-modify-save cycle rewrites the ENTIRE workbook file on every save,
# so two concurrent writers to ANY two Excel-backed operations (same key
# or not) can silently clobber each other's appended rows, not just
# double-fire one operation.
#
# fcntl.flock is a real inter-process lock (not just a threading.Lock,
# which only serializes within one process) — stdlib, no new dependency.
# It also correctly serializes multiple THREADS in the same process: each
# caller opens its own file descriptor against the same path, and flock
# blocks on contention regardless of whether the contending holder is a
# different thread or a different process. That dual coverage matters
# here specifically because this service's real, documented deployment
# (see OPERATIONS.md: `uvicorn app.main:app`, no --workers flag) is a
# SINGLE process — so the concurrency this lock actually has to defend
# against today is FastAPI running sync route handlers like create_invoice/
# create_delivery in a thread pool, not separate OS processes. The lock
# still works correctly if that ever changes to multiple worker processes
# on the same host.
#
# Scope (documented, not silently assumed universal): applied to
# create_delivery/create_invoice only — the two functions Fugu's audit
# specifically flagged and the only two _deliver_and_bill calls. The
# other Excel-writing operations in this codebase (create_sales_order,
# create_purchase_order, create_financial_adjustment,
# process_post_sales_action) are NOT wrapped by this fix and can still
# race against each other or against these two now-locked functions.
#
# Hard limit of this whole approach, not just this lock: fcntl.flock is
# per-MACHINE, not distributed — it provides zero protection the moment
# agent-orchestrator ever runs as more than one process across more than
# one host. If that becomes real, the correct fix is migrating this
# mechanism onto the same Postgres-backed IdempotencyKey table every other
# real-time, cross-service write in this codebase already uses
# (inventory-service/order-service/scheduling-service each have their own
# copy of the same claim/replay/409-on-mismatch pattern) — that would also
# remove the underlying single-file-rewrite fragility noted above, which
# this lock only serializes around rather than eliminates. Not built here:
# genuinely out of scope for a P1 concurrency fix on the current
# single-host deployment, but the real path forward if that deployment
# assumption ever stops holding.
_LOCK_PATH = MOCK_ERP_PATH + ".idempotency.lock"

# Reentrancy tracking (bug found live while extending this lock to
# consignment_tools.py): report_consignment_sale is itself
# @idempotency_lock()-decorated AND calls erp.create_invoice internally,
# which is also @idempotency_lock()-decorated. fcntl.flock is NOT
# reentrant — a nested acquisition from the same thread, even via a new
# open() call on the same path, blocks waiting for the OUTER call's own
# lock to release, which never happens because the outer call is waiting
# on the inner one to return first. Confirmed by reproducing the hang
# (pytest had to be killed after exceeding a 120s timeout) before adding
# this fix. threading.local() makes the wrapper reentrant per-thread: a
# nested call from the SAME thread sees the lock already held and passes
# through without re-flocking (the outer acquisition already covers the
# whole nested call tree); a DIFFERENT thread or process still has its
# own independently-None mode and genuinely blocks on the real flock, so
# cross-thread/cross-process exclusion is unaffected.
#
# Tracks WHICH mode is held ("exclusive" or "shared"), not just whether
# one is held — reliability-pass addition (see read_lock() below): an
# exclusive holder nesting into a function that only needs a shared read
# lock (e.g. resolve_financial_approval calling find_financial_adjustment)
# must pass through too, since exclusive already excludes every other
# locker, shared or exclusive. The one combination this deliberately
# never allows is upgrading shared -> exclusive within the same thread:
# flock() has no safe upgrade path across separate fds (same root cause
# as the non-reentrancy above), and no read function in this codebase
# calls into a writer, so this is treated as a programming error, not a
# case to silently handle.
_lock_state = threading.local()


@contextlib.contextmanager
def _acquire(mode: str, flock_flag: int):
    current = getattr(_lock_state, "mode", None)
    if current == "exclusive":
        yield  # exclusive already excludes everyone; shared or exclusive nested inside it is a safe pass-through
        return
    if current == "shared":
        if mode == "shared":
            yield  # shared nested inside shared is a safe pass-through
            return
        raise RuntimeError(
            "Attempted to acquire the exclusive Excel lock while this thread already "
            "holds the shared (read) lock — lock upgrade is not supported. This means a "
            "read-locked function called into a write-locked one, which should never happen."
        )
    with open(_LOCK_PATH, "w") as lock_file:
        fcntl.flock(lock_file, flock_flag)
        _lock_state.mode = mode
        try:
            yield
        finally:
            _lock_state.mode = None
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def idempotency_lock():
    """Decorator — wraps the ENTIRE decorated function body (the
    check-cache -> execute real operation -> record-result sequence) in
    one exclusive lock, not just the final file write. A fresh lock
    acquisition happens on every call (contextlib.contextmanager results
    are valid decorators via ContextDecorator, stdlib since 3.2, and
    correctly re-enter a new instance per call — this is not one shared
    lock object reused unsafely across invocations). Safe to nest calls
    to other @idempotency_lock()- or @read_lock()-decorated functions
    from within the same thread — see the reentrancy comment above
    _lock_state."""
    return _acquire("exclusive", fcntl.LOCK_EX)


# Reliability-pass addition: closes the confirmed reader-vs-writer crash
# (concurrent openpyxl.load_workbook() reads racing a writer's save(),
# reproduced live as BadZipFile/EOFError on ~8/8 readers under real
# write load) that idempotency_lock() alone never protected against — it
# only ever excluded OTHER writers, since a plain read never checked any
# lock at all. A read wrapped in @read_lock() now takes a REAL shared
# flock: verified on this host that LOCK_SH lets multiple readers
# proceed concurrently (no reader-vs-reader blocking) while still
# correctly waiting out a held LOCK_EX, and that LOCK_EX correctly waits
# out a held LOCK_SH, across threads (see test_concurrency_locks.py).
# Deliberately NOT applied to every read function in the codebase — only
# the high-traffic ones named in the audit plus the read-side of every
# writer already under @idempotency_lock() in this series. The rest
# remain an acknowledged, documented residual risk (see MEMORY/audit
# notes), not silently treated as fixed.
def read_lock():
    """Decorator — shared lock for pure reads. Multiple @read_lock()
    callers may hold it at once; it still correctly excludes (and is
    excluded by) any @idempotency_lock() writer. Do not use this to
    decorate a function that itself calls into an @idempotency_lock()-
    decorated writer — see _acquire's upgrade guard above."""
    return _acquire("shared", fcntl.LOCK_SH)

# The one shared primitive real idempotency actually needs — not a
# framework, just a key/operation -> prior-result lookup. Wired only into
# the operations PLAN.md names (Sales Order, Purchase Order, Delivery,
# Invoice, Credit Memo, Debit Memo): a retried create request for the
# same key returns the exact result it returned the first time instead of
# creating a second real record. Purely additive — idempotency_key is
# optional everywhere it's used, so no existing caller or test is
# affected by not passing one.


def _sheet(wb):
    if "IdempotencyKeys" not in wb.sheetnames:
        sheet = wb.create_sheet("IdempotencyKeys")
        sheet.append(IDEMPOTENCY_HEADERS)
        return sheet
    return wb["IdempotencyKeys"]


def get_idempotent_result(idempotency_key: str | None, operation: str) -> dict | None:
    if not idempotency_key:
        return None
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "IdempotencyKeys" not in wb.sheetnames:
        return None
    sheet = wb["IdempotencyKeys"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        key, op, result_json, _created_at = row
        if key == idempotency_key and op == operation:
            return json.loads(result_json)
    return None


@idempotency_lock()
def record_idempotent_result(idempotency_key: str | None, operation: str, result: dict) -> None:
    if not idempotency_key:
        return
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _sheet(wb)
    sheet.append([idempotency_key, operation, json.dumps(result), datetime.datetime.now().isoformat()])
    save_workbook(wb)


def stage_idempotent_result(wb, idempotency_key: str | None, operation: str, result: dict) -> None:
    """Append the idempotency record to an ALREADY-OPEN workbook without
    saving, so the caller can persist the business row and the key in ONE
    save. record_idempotent_result (load + save of its own) leaves a window
    where the business row is on disk but the key is not: a crash there
    makes a same-key retry create a second real record."""
    if not idempotency_key:
        return
    _sheet(wb).append([idempotency_key, operation, json.dumps(result), datetime.datetime.now().isoformat()])


def save_workbook(wb, path: str = MOCK_ERP_PATH) -> None:
    """Crash-safe replacement for ``wb.save(path)``.

    openpyxl writes the target file in place, so a process killed mid-save (or
    a reader that does not hold the lock) can see a truncated, unreadable
    workbook, and one such event destroys the entire mock ERP. This writes the
    complete workbook to a temp file in the SAME directory, flushes it to disk,
    then ``os.replace``s it over the target. replace is atomic on POSIX, so the
    path always holds either the old complete workbook or the new complete one,
    and lock-free readers can never observe a partial file.

    It does NOT make read-modify-write sequences atomic: callers that load the
    workbook, change it and save it must still hold ``idempotency_lock()`` for
    the whole sequence, or a concurrent writer's changes are lost."""
    directory = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(directory, f".{os.path.basename(path)}.tmp-{os.getpid()}-{threading.get_ident()}")
    try:
        wb.save(tmp)
        with open(tmp, "rb") as handle:
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
