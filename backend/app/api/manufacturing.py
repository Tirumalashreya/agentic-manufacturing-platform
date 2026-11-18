# enterprise-aps-platform/backend/app/api/manufacturing.py
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from app.core.database import get_db
from app.models.master_data import WorkCenter, Machine, Material
from app.models.manufacturing import ProductionOrder, ScheduledOperation

router = APIRouter(prefix="/manufacturing", tags=["Manufacturing & Shop Floor"])


@router.get("/work-centers")
async def list_work_centers(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(WorkCenter))
    work_centers = result.scalars().all()

    response = []
    for wc in work_centers:
        m_res = await db.execute(select(Machine).where(Machine.work_center_id == wc.id))
        machines = m_res.scalars().all()
        response.append({
            "id": wc.id,
            "code": wc.code,
            "name": wc.name,
            "capacity_hours_per_day": wc.capacity_hours_per_day,
            "hourly_rate": wc.hourly_rate,
            "machines": [
                {
                    "id": m.id,
                    "code": m.code,
                    "name": m.name,
                    "status": m.status,
                    "efficiency_factor": m.efficiency_factor,
                }
                for m in machines
            ],
        })
    return response


@router.get("/materials")
async def list_materials(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Material))
    materials = result.scalars().all()
    return [
        {
            "id": m.id,
            "sku": m.sku,
            "name": m.name,
            "description": m.description,
            "material_type": m.material_type,
            "unit_of_measure": m.unit_of_measure,
            "standard_cost": m.standard_cost,
            "current_stock": m.current_stock,
            "safety_stock": m.safety_stock,
            "lead_time_days": m.lead_time_days,
        }
        for m in materials
    ]


@router.get("/production-orders")
async def list_production_orders(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ProductionOrder).order_by(ProductionOrder.created_at.desc()))
    orders = result.scalars().all()

    response = []
    for po in orders:
        mat_res = await db.execute(select(Material).where(Material.id == po.material_id))
        mat = mat_res.scalar_one_or_none()
        response.append({
            "id": po.id,
            "order_number": po.order_number,
            "material_name": mat.name if mat else "Unknown",
            "material_sku": mat.sku if mat else "",
            "target_quantity": po.target_quantity,
            "completed_quantity": po.completed_quantity,
            "status": po.status,
            "scheduled_start": po.scheduled_start.isoformat() if po.scheduled_start else None,
            "scheduled_end": po.scheduled_end.isoformat() if po.scheduled_end else None,
        })
    return response
