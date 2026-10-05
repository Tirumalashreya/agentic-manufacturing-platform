"""
§9 Optimization Engine — the CP-SAT (OR-Tools) strategy specifically:
"Applied to 1-5 day planning zone; NoOverlap + Precedence + Resource
constraints; time limit 300s". This is the one piece of the Optimization
Engine implemented in Python rather than Node, because it needs a real
constraint-programming solver (Google OR-Tools) that doesn't have a solid
Node.js binding — everything else in §9 (TSP/local-search/greedy heuristics)
lives in optimization-service (Node) and calls here only for this strategy.

Model: one interval variable per job (fixed duration, movable start), a
NoOverlap constraint per machine (the "Resource constraints" in the doc),
and start[after] >= end[before] for every precedence edge. Objective:
minimize makespan (finish time of the last job) — the standard CP-SAT
job-shop objective.
"""

import os
import time

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel
from ortools.sat.python import cp_model

app = FastAPI()


# Auth/Authz hardening, Phase 1 (Finding 1.1) — this service is internal-
# only (called exclusively by optimization-service), so it gets the same
# shared internal-service-token check every TS service now enforces, kept
# self-contained here rather than a new shared Python package for one
# small file. Fail closed if the token isn't configured — see
# packages/shared/src/serviceAuth.ts's identical TS-side default.
def require_service_token(x_internal_token: str | None = Header(default=None, alias="x-internal-token")) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="Service misconfigured — internal auth token not set")
    if not x_internal_token:
        raise HTTPException(status_code=401, detail="Missing internal service credential")
    if x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Invalid internal service credential")


class Job(BaseModel):
    id: str
    durationMin: int
    machineId: str
    earliestStartMin: int = 0


class Precedence(BaseModel):
    beforeId: str
    afterId: str


class SolveRequest(BaseModel):
    jobs: list[Job]
    precedences: list[Precedence] = []
    horizonMin: int
    timeLimitSeconds: float = 30.0  # doc default is 300s; kept low here for interactive verification


class Assignment(BaseModel):
    id: str
    startMin: int
    endMin: int


class SolveResponse(BaseModel):
    status: str
    solveTimeMs: int
    makespanMin: int | None
    assignments: list[Assignment]


@app.get("/health")
def health():
    return {"status": "ok", "service": "optimization-solver"}


@app.post("/solve/cp-sat", response_model=SolveResponse, dependencies=[Depends(require_service_token)])
def solve_cp_sat(req: SolveRequest):
    start_time = time.time()
    model = cp_model.CpModel()

    starts = {}
    ends = {}
    intervals = {}
    machine_intervals: dict[str, list] = {}

    for job in req.jobs:
        start = model.NewIntVar(job.earliestStartMin, req.horizonMin, f"start_{job.id}")
        end = model.NewIntVar(job.earliestStartMin, req.horizonMin, f"end_{job.id}")
        interval = model.NewIntervalVar(start, job.durationMin, end, f"interval_{job.id}")
        starts[job.id] = start
        ends[job.id] = end
        intervals[job.id] = interval
        machine_intervals.setdefault(job.machineId, []).append(interval)

    # "Resource constraints": no two jobs on the same machine may overlap.
    for machine_id, ivs in machine_intervals.items():
        if len(ivs) > 1:
            model.AddNoOverlap(ivs)

    # "Precedence": a job can't start before its predecessor finishes.
    for prec in req.precedences:
        if prec.beforeId in ends and prec.afterId in starts:
            model.Add(starts[prec.afterId] >= ends[prec.beforeId])

    makespan = model.NewIntVar(0, req.horizonMin, "makespan")
    if ends:
        model.AddMaxEquality(makespan, list(ends.values()))
    model.Minimize(makespan)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = req.timeLimitSeconds
    status = solver.Solve(model)

    status_name = solver.StatusName(status)
    solve_time_ms = int((time.time() - start_time) * 1000)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SolveResponse(status=status_name, solveTimeMs=solve_time_ms, makespanMin=None, assignments=[])

    assignments = [
        Assignment(id=job.id, startMin=solver.Value(starts[job.id]), endMin=solver.Value(ends[job.id]))
        for job in req.jobs
    ]
    return SolveResponse(
        status=status_name,
        solveTimeMs=solve_time_ms,
        makespanMin=solver.Value(makespan),
        assignments=assignments,
    )
