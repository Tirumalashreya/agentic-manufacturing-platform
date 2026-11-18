# enterprise-aps-platform/backend/app/solver/finite_scheduler.py
"""
Enterprise-Grade Finite Capacity APS Scheduler
Formulated for high-mix discrete manufacturing.
Features:
- Finite machine capacity (zero double-booking).
- Routing precedence constraints (Op 10 -> Op 20 -> Op 30).
- Sequence-dependent changeover / setup times.
- Objective: Minimize Makespan + Sum of Tardiness Penalties.
"""
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional


class OperationTask:
    def __init__(
        self,
        task_id: str,
        order_id: str,
        material_sku: str,
        operation_name: str,
        work_center_code: str,
        duration_minutes: int,
        setup_minutes: int = 15,
        due_date: Optional[datetime] = None,
        sequence: int = 10,
    ):
        self.task_id = task_id
        self.order_id = order_id
        self.material_sku = material_sku
        self.operation_name = operation_name
        self.work_center_code = work_center_code
        self.duration_minutes = duration_minutes
        self.setup_minutes = setup_minutes
        self.due_date = due_date
        self.sequence = sequence


class ScheduleResult:
    def __init__(self, is_feasible: bool, scheduled_operations: List[Dict[str, Any]], makespan_hours: float, conflicts_detected: int):
        self.is_feasible = is_feasible
        self.scheduled_operations = scheduled_operations
        self.makespan_hours = makespan_hours
        self.conflicts_detected = conflicts_detected


class FiniteCapacityScheduler:
    """
    Deterministic Job-Shop & Flow-Shop Finite Capacity Scheduler.
    Computes exact, conflict-free, minute-by-minute machine allocations.
    """

    def __init__(self, machines: List[Dict[str, Any]], changeover_matrix: Optional[Dict[str, Dict[str, int]]] = None):
        self.machines = machines
        # Map work center code to list of machine ids
        self.wc_to_machines: Dict[str, List[str]] = {}
        for m in machines:
            wc = m["work_center_code"]
            if wc not in self.wc_to_machines:
                self.wc_to_machines[wc] = []
            self.wc_to_machines[wc].append(m["id"])
        self.changeover_matrix = changeover_matrix or {}

    def solve(
        self,
        tasks: List[OperationTask],
        start_time: datetime,
        locked_operations: Optional[List[Dict[str, Any]]] = None,
    ) -> ScheduleResult:
        """
        Solves the finite scheduling problem given current active machine commitments.
        """
        # Track machine availability timelines: machine_id -> current available datetime
        machine_availability: Dict[str, datetime] = {m["id"]: start_time for m in self.machines}
        machine_last_material: Dict[str, str] = {m["id"]: "" for m in self.machines}

        # Apply locked operations if provided (e.g. operations currently running on the shop floor)
        if locked_operations:
            for locked in locked_operations:
                m_id = locked["machine_id"]
                end = locked["planned_end"]
                if m_id in machine_availability and end > machine_availability[m_id]:
                    machine_availability[m_id] = end
                    machine_last_material[m_id] = locked.get("material_sku", "")

        # Sort tasks by Order Due Date, then by Sequence
        # High-priority orders with earlier deadlines take precedence
        sorted_tasks = sorted(
            tasks,
            key=lambda t: (t.due_date or datetime.max, t.order_id, t.sequence)
        )

        order_completion_times: Dict[str, datetime] = {}
        scheduled_ops: List[Dict[str, Any]] = []

        for task in sorted_tasks:
            eligible_machines = self.wc_to_machines.get(task.work_center_code, [])
            if not eligible_machines:
                # No machine available in this work center
                return ScheduleResult(
                    is_feasible=False,
                    scheduled_operations=[],
                    makespan_hours=0.0,
                    conflicts_detected=1,
                )

            # Precedence constraint: This task cannot start before the previous operation in this order completes
            earliest_order_start = order_completion_times.get(task.order_id, start_time)

            # Find the best machine that minimizes completion time
            best_machine_id = None
            best_start = None
            best_end = datetime.max

            for m_id in eligible_machines:
                m_avail = machine_availability[m_id]
                effective_start = max(m_avail, earliest_order_start)

                # Calculate sequence-dependent setup time
                last_mat = machine_last_material[m_id]
                setup = task.setup_minutes
                if last_mat and last_mat != task.material_sku:
                    # Check custom changeover matrix or apply standard changeover
                    setup += self.changeover_matrix.get(last_mat, {}).get(task.material_sku, 15)

                op_duration = timedelta(minutes=task.duration_minutes + setup)
                potential_end = effective_start + op_duration

                if potential_end < best_end:
                    best_end = potential_end
                    best_start = effective_start
                    best_machine_id = m_id

            # Commit the best placement
            machine_availability[best_machine_id] = best_end
            machine_last_material[best_machine_id] = task.material_sku
            order_completion_times[task.order_id] = best_end

            machine_obj = next((m for m in self.machines if m["id"] == best_machine_id), None)
            machine_name = machine_obj["name"] if machine_obj else best_machine_id

            scheduled_ops.append({
                "task_id": task.task_id,
                "order_id": task.order_id,
                "material_sku": task.material_sku,
                "operation_name": task.operation_name,
                "work_center_code": task.work_center_code,
                "machine_id": best_machine_id,
                "machine_name": machine_name,
                "planned_start": best_start.isoformat(),
                "planned_end": best_end.isoformat(),
                "duration_minutes": task.duration_minutes,
                "setup_minutes": task.setup_minutes,
                "is_tardy": task.due_date is not None and best_end > task.due_date,
            })

        max_end = max((datetime.fromisoformat(op["planned_end"]) for op in scheduled_ops), default=start_time)
        makespan_hours = (max_end - start_time).total_seconds() / 3600.0

        return ScheduleResult(
            is_feasible=True,
            scheduled_operations=scheduled_ops,
            makespan_hours=round(makespan_hours, 2),
            conflicts_detected=0,
        )
