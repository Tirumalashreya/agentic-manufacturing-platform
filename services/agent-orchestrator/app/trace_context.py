# app/trace_context.py
"""Stage 07 (Observability/Correlation) — the one real end-to-end
correlation identifier for a workflow. Deliberately a contextvars.ContextVar,
not a new parameter threaded through every one of the ~40 individual tool/
integration call sites in this service (that would mean touching every
function signature between here and the actual httpx call — exactly the
"redesign" this stage explicitly rules out). Set ONCE, at the top of a real
run (app/routers/pipeline.py's start_run), read automatically by
manufacturing_services.py's _internal_headers() so every outbound call made
during that run's execution — regardless of how many functions deep it is —
carries the same x-trace-id a human or an operator can later grep every
service's logs for, with zero changes to any of those functions themselves.

Uses contextvars (not a plain module-level global) specifically because
this is an async service handling concurrent requests on one event loop —
a plain global would leak one request's trace_id into another's concurrent
calls; contextvars.ContextVar is explicitly designed to stay correctly
isolated per async task."""
from contextvars import ContextVar

_current_trace_id: ContextVar[str | None] = ContextVar("current_trace_id", default=None)


def set_trace_id(trace_id: str) -> None:
    _current_trace_id.set(trace_id)


def get_trace_id() -> str | None:
    return _current_trace_id.get()
