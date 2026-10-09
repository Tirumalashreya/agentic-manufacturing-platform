# app/routers/pipeline.py
import logging
import time
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.approval_proposal import compute_proposal_hash
from app.graph import graph
from app.integrations.manufacturing_services import AGENT_ORCHESTRATOR_ENTERPRISE_ID
from app.security import ForwardedUser, require_user
from app.trace_context import set_trace_id

router = APIRouter()
logger = logging.getLogger(__name__)


class RunRequest(BaseModel):
    message: str


# Run-tracking (AgentPipelineRun/AgentStageResult) needs a real
# DATABASE_URL, which isn't configured in this environment — best-effort
# so a missing DB doesn't block the actual workflow from running. Not
# removed: PLAN.md documents this as real, working infra for whoever
# does have DATABASE_URL set.
async def _try_create_run() -> str | None:
    try:
        return await db.create_run()
    except Exception:
        logger.warning("Run-tracking unavailable (no DATABASE_URL?) — continuing without it.")
        return None


async def _try_finish_run(run_id: str | None, status: str) -> None:
    if run_id is None:
        return
    try:
        await db.finish_run(run_id, status)
    except Exception:
        logger.warning("Could not record run completion — continuing without it.")


async def _try_log_stage(run_id: str | None, node_name: str, delta: dict) -> None:
    if run_id is None:
        return
    try:
        await db.log_stage(run_id, node_name, delta)
    except Exception:
        logger.warning("Could not record stage %s — continuing without it.", node_name)


@router.post("/pipeline/runs")
async def start_run(body: RunRequest, user: ForwardedUser = Depends(require_user)):
    run_id = await _try_create_run()
    # Stage 07 (Observability/Correlation): run_id IS this system's real
    # root correlation id for a workflow — set once, here, for the
    # contextvar every outbound call for the rest of this request reads
    # automatically (see app/trace_context.py). Falls back to a fresh id
    # when run-tracking itself is unavailable (DATABASE_URL unset) so a
    # trace_id always exists to forward/log, even though it then has no
    # durable AgentPipelineRun row behind it.
    set_trace_id(run_id or f"untracked-{uuid4()}")

    # Streaming ("updates" mode) instead of graph.ainvoke() gives the same
    # final state (SalesState has no custom reducers, so folding every
    # node's delta over the accumulator is equivalent to LangGraph's own
    # merge) plus something ainvoke() throws away: which node actually
    # ran, in what order, and exactly what it added. That's the real
    # "what did each agent output and how did it route" trace — reading
    # it off the final merged dict would just be guessing which field
    # came from which stage.
    merged: dict = {"user_message": body.message}
    stages: list[dict] = []
    # Stage 07 (AI decision record): real per-node wall-clock duration —
    # free, since this loop already awaits each node's completion in
    # order; no change to any of the ~20 individual LLM-calling agent
    # modules needed to get it. provider ("groq") and model (GROQ_MODEL,
    # app/config.py) are deliberately NOT repeated on every row — they're
    # fixed, repo-wide constants today, not per-call data, so storing them
    # per stage would be padding, not a real decision record; this
    # documents that rather than inventing a column nothing actually varies.
    stage_started_at = time.monotonic()
    try:
        async for update in graph.astream({"user_message": body.message}, stream_mode="updates"):
            now = time.monotonic()
            for node_name, delta in update.items():
                duration_ms = round((now - stage_started_at) * 1000)
                stages.append({"node": node_name, "output": delta, "duration_ms": duration_ms})
                merged.update(delta)
                await _try_log_stage(run_id, node_name, {**delta, "_duration_ms": duration_ms})
            stage_started_at = now
    except Exception:
        await _try_finish_run(run_id, "FAILED")
        raise

    await _try_finish_run(run_id, "COMPLETED")

    # Approval State hardening (agreed with the user) — the graph itself
    # doesn't know or care whether it's being durably tracked; this is the
    # one place a real human-approval gate (composed_execution's
    # create_order, or reschedule_request's RESCHEDULE_PRODUCTION) gets
    # bound to a real, server-owned record before anything is ever shown
    # to the human. Unlike run-tracking/stage-logging above (pure
    # observability, fine to degrade silently), a gate reached with no
    # run_id to bind it to CANNOT be durably approved at all — returning
    # pending_approval to the client anyway would just resurrect the old
    # client-echoed-context hole this phase exists to close. Fails loudly
    # instead.
    pending = merged.get("pending_approval")
    if pending is not None:
        if run_id is None:
            raise HTTPException(
                status_code=503,
                detail="Approval could not be recorded (run tracking unavailable) — cannot safely present this for approval.",
            )
        await db.save_pending_approval(
            run_id=run_id,
            action=pending["action"],
            payload=pending["context"],
            requested_by=user.user_id,
            enterprise_id=AGENT_ORCHESTRATOR_ENTERPRISE_ID,
            proposal_hash=compute_proposal_hash(pending["action"], pending["context"]),
        )

    return {"run_id": run_id, "user_message": body.message, "stages": stages, **merged}


# Read side for the Production Planning page's Plan History section — the
# write side (create_run/log_stage/finish_run above) already existed;
# nothing ever read it back before this. Best-effort, matching the write
# side's own philosophy: an unreachable/unset DATABASE_URL returns an
# empty list rather than a 500, since a demo run with no DB configured is
# a normal, already-supported state, not an error state.
@router.get("/pipeline/runs")
async def list_pipeline_runs(limit: int = 50):
    try:
        return {"items": await db.list_runs(limit)}
    except Exception:
        logger.warning("Run history unavailable (no DATABASE_URL?) — returning empty list.")
        return {"items": []}


# Powers Agent Console's "Pending decisions" panel — lets a run left
# sitting at the approval gate be resumed after "New session" (or just
# navigating away) wiped it from the browser. See db.list_pending_approvals
# for the real limitation: this can't detect a run resolved by some other
# means (e.g. retyping the same request), only that this exact run hasn't
# been through this exact recovery path.
@router.get("/pipeline/pending")
async def list_pending_approvals(limit: int = 20):
    try:
        return {"items": await db.list_pending_approvals(limit)}
    except Exception:
        logger.warning("Pending-approval history unavailable (no DATABASE_URL?) — returning empty list.")
        return {"items": []}


@router.get("/pipeline/runs/{run_id}")
async def get_pipeline_run(run_id: str):
    try:
        run = await db.get_run(run_id)
    except Exception:
        logger.warning("Run detail unavailable (no DATABASE_URL?).")
        return None
    return run
