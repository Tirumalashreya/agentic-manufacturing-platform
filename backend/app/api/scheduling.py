# enterprise-aps-platform/backend/app/api/scheduling.py
from datetime import datetime, timedelta
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.core.database import get_db
from app.models.master_data import WorkCenter, Machine, Material
from app.models.manufacturing import ProductionOrder, ScheduledOperation
from app.solver.finite_scheduler import FiniteCapacityScheduler, OperationTask
from app.agents.disruption_copilot import DisruptionCopilot

router = APIRouter(prefix="/scheduling", tags=["Finite Capacity APS"])


@router.get("/gantt")
async def get_gantt_schedule(db: AsyncSession = Depends(get_db)):
    """
    Returns the real-time finite capacity Gantt chart data:
    Tracks machines, work centers, and allocated operational blocks.
    """
    m_res = await db.execute(select(Machine))
    machines = m_res.scalars().all()

    wc_res = await db.execute(select(WorkCenter))
    work_centers = {wc.id: wc for wc in wc_res.scalars().all()}

    op_res = await db.execute(select(ScheduledOperation).order_by(ScheduledOperation.planned_start))
    operations = op_res.scalars().all()

    # Build machine rows
    machine_rows = []
    for m in machines:
        wc = work_centers.get(m.work_center_id)
        m_ops = [
            {
                "id": op.id,
                "order_id": op.production_order_id,
                "operation_name": op.operation_name,
                "planned_start": op.planned_start.isoformat(),
                "planned_end": op.planned_end.isoformat(),
                "duration_minutes": op.duration_minutes,
                "setup_minutes": op.setup_minutes,
                "status": op.status,
            }
            for op in operations if op.machine_id == m.id
        ]
        machine_rows.append({
            "machine_id": m.id,
            "machine_code": m.code,
            "machine_name": m.name,
            "work_center_code": wc.code if wc else "WC-GEN",
            "work_center_name": wc.name if wc else "General",
            "status": m.status,
            "operations": m_ops,
        })

    return {
        "schedule_generated_at": datetime.utcnow().isoformat(),
        "total_machines": len(machines),
        "total_operations_scheduled": len(operations),
        "resources": machine_rows,
    }


@router.post("/disruption/simulate")
async def simulate_disruption(payload: Dict[str, Any], db: AsyncSession = Depends(get_db)):
    """
    Agentic Disruption Copilot:
    Evaluates blast radius of a machine breakdown or material delay
    and returns ranked mitigation scenarios.
    """
    machine_code = payload.get("machine_code", "M-01")
    downtime_hours = float(payload.get("downtime_hours", 4.0))

    # Fetch machines
    m_res = await db.execute(select(Machine))
    machines = [
        {"id": m.id, "code": m.code, "name": m.name, "status": m.status, "work_center_id": m.work_center_id}
        for m in m_res.scalars().all()
    ]

    # Fetch active operations
    op_res = await db.execute(select(ScheduledOperation))
    active_ops = [
        {"id": op.id, "machine_id": op.machine_id, "operation_name": op.operation_name}
        for op in op_res.scalars().all()
    ]

    analysis = DisruptionCopilot.analyze_machine_failure(
        machine_code=machine_code,
        expected_downtime_hours=downtime_hours,
        active_operations=active_ops,
        available_machines=machines,
    )
    return analysis
