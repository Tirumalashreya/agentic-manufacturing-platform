# app/routers/pipeline.py
from fastapi import APIRouter
from pydantic import BaseModel

from app import db
from app.graph import pipeline_graph

router = APIRouter()


class RunRequest(BaseModel):
    raw_demand_input: str


@router.post("/pipeline/runs")
async def start_run(body: RunRequest):
    run_id = await db.create_run()
    try:
        result = await pipeline_graph.ainvoke(
            {"run_id": run_id, "raw_demand_input": body.raw_demand_input}
        )
        await db.finish_run(run_id, "COMPLETED")
        return {"run_id": run_id, "status": "COMPLETED", "demand_forecast": result["demand_forecast"]}
    except Exception as e:
        await db.finish_run(run_id, "FAILED")
        raise
