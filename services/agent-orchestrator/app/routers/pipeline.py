# app/routers/pipeline.py
import logging

from fastapi import APIRouter
from pydantic import BaseModel

from app import db
from app.graph import graph

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


@router.post("/pipeline/runs")
async def start_run(body: RunRequest):
    run_id = await _try_create_run()

    try:
        result = await graph.ainvoke({"user_message": body.message})
    except Exception:
        await _try_finish_run(run_id, "FAILED")
        raise

    await _try_finish_run(run_id, "COMPLETED")
    return {"run_id": run_id, "user_message": body.message, **result}
