# app/main.py
import logging
from uuid import uuid4

from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers.approvals import router as approvals_router
from app.routers.audit import router as audit_router
from app.routers.channels import router as channels_router
from app.routers.disruptions import router as disruptions_router
from app.routers.masterdata import router as masterdata_router
from app.routers.pipeline import router as pipeline_router
from app.routers.production import router as production_router
from app.routers.sales_orders import router as sales_orders_router
from app.routers.workflows import router as workflows_router
from app.security import require_service_token
from app.trace_context import get_trace_id, set_trace_id

logger = logging.getLogger(__name__)

app = FastAPI(title="agent-orchestrator")

ALLOWED_ORIGIN = "http://localhost:3000"

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth/Authz hardening, Phase 1 (Finding 1.3): every router below previously
# had zero authentication — reachable by anyone who could resolve this
# service's URL, including straight from a browser (Finding 1.2). The
# shared internal-service token is now required on every route by default
# (this app-wide dependency); the specific routes a real human commits from
# (approve, mark-paid, reschedule) additionally require a forwarded,
# authenticated user via require_role — see each router's own per-route
# Depends(require_role(...)) for exactly which ones and why.
app.include_router(pipeline_router, dependencies=[Depends(require_service_token)])
app.include_router(approvals_router, dependencies=[Depends(require_service_token)])
app.include_router(audit_router, dependencies=[Depends(require_service_token)])
app.include_router(workflows_router, dependencies=[Depends(require_service_token)])
app.include_router(channels_router, dependencies=[Depends(require_service_token)])
app.include_router(masterdata_router, dependencies=[Depends(require_service_token)])
app.include_router(production_router, dependencies=[Depends(require_service_token)])
app.include_router(sales_orders_router, dependencies=[Depends(require_service_token)])
app.include_router(disruptions_router, dependencies=[Depends(require_service_token)])


# Handlers for the bare Exception class run inside Starlette's
# ServerErrorMiddleware, which wraps CORSMiddleware from the outside — so a
# response built here never passes back through CORSMiddleware to get its
# Access-Control-Allow-Origin header. Without that header, the browser
# reports a misleading "CORS policy" / "Failed to fetch" for what is
# actually an ordinary 500 (e.g. a missing GROQ_API_KEY). Adding the header
# by hand here is the fix, not a workaround — no code before this point on
# the response path is positioned to add it.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Phase 17 (Production Readiness & Observability) — real gap found:
    # this only ever fires for a genuinely unexpected failure (every
    # deliberate business error already raises HTTPException, handled by
    # FastAPI's own built-in handler before this one ever runs — never
    # touched by this change), yet it was returning the raw exception's own
    # message straight to the caller, which Ledger's lib/api.ts then
    # surfaces verbatim in the UI. str(exc) on a genuine bug can be a raw
    # DB driver message, an internal dict key, or similar — not something
    # meant for a planner's screen. The real exception is still fully
    # logged server-side (unchanged); the trace_id ties the two together
    # so "something went wrong" stays actionable without leaking internals.
    trace_id = get_trace_id() or f"untraced-{uuid4()}"
    set_trace_id(trace_id)
    logger.exception("Unhandled error on %s [trace_id=%s]", request.url.path, trace_id)
    return JSONResponse(
        status_code=500,
        content={"detail": f"An unexpected error occurred. Reference: {trace_id}"},
        headers={"Access-Control-Allow-Origin": ALLOWED_ORIGIN, "x-trace-id": trace_id},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}
