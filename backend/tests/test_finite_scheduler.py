import pytest
from datetime import datetime
from app.solver.finite_scheduler import FiniteCapacityScheduler, OperationTask

def test_cpsat_solver_solves_job_shop():
    machines = [
        {"id": "M-LASER-01", "work_center_code": "WC-CUT", "name": "Fiber Laser"},
        {"id": "M-CNC-01", "work_center_code": "WC-CNC", "name": "5-Axis CNC"},
    ]
    scheduler = FiniteCapacityScheduler(machines=machines)

    start_time = datetime(2026, 11, 20, 8, 0, 0)
    tasks = [
        OperationTask(
            task_id="T-10",
            order_id="ORD-01",
            material_sku="BRK-100",
            operation_name="Laser Cut Blank",
            work_center_code="WC-CUT",
            duration_minutes=60,
            setup_minutes=15,
            sequence=10
        ),
        OperationTask(
            task_id="T-20",
            order_id="ORD-01",
            material_sku="BRK-100",
            operation_name="Precision Milling",
            work_center_code="WC-CNC",
            duration_minutes=90,
            setup_minutes=15,
            sequence=20
        ),
        OperationTask(
            task_id="T-30",
            order_id="ORD-02",
            material_sku="BRK-200",
            operation_name="Laser Cut Sheet",
            work_center_code="WC-CUT",
            duration_minutes=45,
            setup_minutes=15,
            sequence=10
        ),
    ]

    result = scheduler.solve(tasks=tasks, start_time=start_time)
    assert result.is_feasible is True
    assert len(result.scheduled_operations) == 3
    assert result.conflicts_detected == 0
    assert result.makespan_hours > 0

    # Ensure no machine conflict on M-LASER-01
    laser_ops = [op for op in result.scheduled_operations if op["machine_id"] == "M-LASER-01"]
    assert len(laser_ops) == 2
    laser_ops.sort(key=lambda x: x["planned_start"])
    assert laser_ops[0]["planned_end"] <= laser_ops[1]["planned_start"]
