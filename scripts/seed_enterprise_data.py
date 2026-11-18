# enterprise-aps-platform/scripts/seed_enterprise_data.py
import asyncio
import sys
import os
from datetime import datetime, timedelta

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from app.core.database import AsyncSessionLocal, init_db
from app.models.master_data import Enterprise, Plant, WorkCenter, Machine, Material, BillOfMaterial, BOMItem, Routing, RoutingOperation
from app.models.sales import Customer, SalesOrder, SalesOrderLine, DeliveryPromise
from app.models.manufacturing import ProductionOrder, ScheduledOperation


async def seed():
    print("Initializing Enterprise Database...")
    await init_db()

    async with AsyncSessionLocal() as db:
        print("Seeding Master Enterprise Organization...")
        enterprise = Enterprise(name="Global Aerospace & Industrial Corp", code="GAIC")
        db.add(enterprise)
        await db.flush()

        plant = Plant(
            enterprise_id=enterprise.id,
            name="Plant 01 - Precision Manufacturing Complex",
            code="PLANT-01",
            location="Chicago Advanced Manufacturing Campus"
        )
        db.add(plant)
        await db.flush()

        print("Seeding Work Centers & Machines...")
        wc_cut = WorkCenter(plant_id=plant.id, code="WC-CUT", name="CNC Laser Cutting", capacity_hours_per_day=16.0, hourly_rate=85.0)
        wc_cnc = WorkCenter(plant_id=plant.id, code="WC-CNC", name="Precision 5-Axis Milling", capacity_hours_per_day=16.0, hourly_rate=110.0)
        wc_assy = WorkCenter(plant_id=plant.id, code="WC-ASSY", name="Robotic Assembly", capacity_hours_per_day=16.0, hourly_rate=75.0)
        wc_qc = WorkCenter(plant_id=plant.id, code="WC-PACK", name="Inspection & Packaging", capacity_hours_per_day=16.0, hourly_rate=60.0)

        db.add_all([wc_cut, wc_cnc, wc_assy, wc_qc])
        await db.flush()

        # Machines
        machines = [
            Machine(work_center_id=wc_cut.id, code="LASER-01", name="Amada 4kW Fiber Laser", status="ACTIVE"),
            Machine(work_center_id=wc_cut.id, code="LASER-02", name="Trumpf TruLaser 3030", status="ACTIVE"),
            Machine(work_center_id=wc_cnc.id, code="CNC-01", name="Haas 5-Axis Machining Center", status="ACTIVE"),
            Machine(work_center_id=wc_cnc.id, code="CNC-02", name="DMG Mori DMU 50", status="ACTIVE"),
            Machine(work_center_id=wc_cnc.id, code="CNC-03", name="Mazak Variaxis C-600", status="ACTIVE"),
            Machine(work_center_id=wc_assy.id, code="ASY-01", name="Automated Assembly Station Alpha", status="ACTIVE"),
            Machine(work_center_id=wc_assy.id, code="ASY-02", name="Assembly Cell Beta", status="ACTIVE"),
            Machine(work_center_id=wc_qc.id, code="QC-01", name="Zeiss CMM Optical Inspection Cell", status="ACTIVE"),
            Machine(work_center_id=wc_qc.id, code="PACK-01", name="Automated Packaging & Crating Unit", status="ACTIVE"),
        ]
        db.add_all(machines)
        await db.flush()

        print("Seeding Materials & Multi-Level BOMs...")
        mat_cmk = Material(sku="CMK-100", name="Cable Management Kit", material_type="FINISHED", standard_cost=650.0, current_stock=165.0, safety_stock=20.0)
        mat_pmp = Material(sku="PMP-500", name="Industrial Hydraulic Pump", material_type="FINISHED", standard_cost=2400.0, current_stock=12.0, safety_stock=5.0)
        mat_sns = Material(sku="SNS-200", name="Precision Optical Sensor", material_type="FINISHED", standard_cost=1250.0, current_stock=48.0, safety_stock=15.0)

        # Raw materials
        mat_steel = Material(sku="RAW-STL-01", name="316L Stainless Steel Plate", material_type="RAW", standard_cost=45.0, current_stock=1500.0)
        mat_fastener = Material(sku="RAW-FST-02", name="M6 Titanium Socket Screws", material_type="RAW", standard_cost=3.5, current_stock=5000.0)
        mat_wire = Material(sku="RAW-WIR-03", name="Shielded Braided Harness Wire", material_type="RAW", standard_cost=12.0, current_stock=2500.0)

        db.add_all([mat_cmk, mat_pmp, mat_sns, mat_steel, mat_fastener, mat_wire])
        await db.flush()

        # BOM for Cable Management Kit
        bom_cmk = BillOfMaterial(finished_material_id=mat_cmk.id, version="2.1")
        db.add(bom_cmk)
        await db.flush()
        db.add_all([
            BOMItem(bom_id=bom_cmk.id, component_material_id=mat_steel.id, quantity_per=1.5, scrap_factor_pct=2.0),
            BOMItem(bom_id=bom_cmk.id, component_material_id=mat_fastener.id, quantity_per=8.0, scrap_factor_pct=0.5),
            BOMItem(bom_id=bom_cmk.id, component_material_id=mat_wire.id, quantity_per=4.0, scrap_factor_pct=1.0),
        ])

        # Routing for Cable Management Kit
        routing_cmk = Routing(material_id=mat_cmk.id, name="CMK Standard Production Routing")
        db.add(routing_cmk)
        await db.flush()
        db.add_all([
            RoutingOperation(routing_id=routing_cmk.id, work_center_id=wc_cut.id, sequence=10, operation_name="Laser Cut Enclosure Shell", setup_minutes=20.0, run_minutes_per_unit=4.0),
            RoutingOperation(routing_id=routing_cmk.id, work_center_id=wc_cnc.id, sequence=20, operation_name="Precision Milling & Tapping", setup_minutes=30.0, run_minutes_per_unit=8.0),
            RoutingOperation(routing_id=routing_cmk.id, work_center_id=wc_assy.id, sequence=30, operation_name="Wire Loom & Bracket Assembly", setup_minutes=15.0, run_minutes_per_unit=12.0),
            RoutingOperation(routing_id=routing_cmk.id, work_center_id=wc_qc.id, sequence=40, operation_name="Coordinate Metrology & Packaging", setup_minutes=10.0, run_minutes_per_unit=5.0),
        ])

        print("Seeding Enterprise Customers...")
        cust1 = Customer(customer_number="CUST-1001", name="Boeing Aerospace", credit_limit=2500000.0, current_exposure=450000.0, payment_terms="NET45")
        cust2 = Customer(customer_number="CUST-1002", name="Orion Systems", credit_limit=150000.0, current_exposure=12000.0, payment_terms="NET30")
        cust3 = Customer(customer_number="CUST-1003", name="Siemens Energy", credit_limit=1000000.0, current_exposure=85000.0, payment_terms="NET30")
        db.add_all([cust1, cust2, cust3])
        await db.flush()

        print("Seeding Active Production Orders & Gantt Schedule...")
        now = datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        po1 = ProductionOrder(
            order_number="PO-2026-0081",
            material_id=mat_cmk.id,
            target_quantity=50.0,
            status="IN_PROGRESS",
            scheduled_start=now,
            scheduled_end=now + timedelta(hours=8)
        )
        po2 = ProductionOrder(
            order_number="PO-2026-0082",
            material_id=mat_pmp.id,
            target_quantity=20.0,
            status="SCHEDULED",
            scheduled_start=now + timedelta(hours=4),
            scheduled_end=now + timedelta(hours=14)
        )
        db.add_all([po1, po2])
        await db.flush()

        # Scheduled Operations on Machines
        db.add_all([
            ScheduledOperation(
                production_order_id=po1.id,
                machine_id=machines[0].id,  # LASER-01
                work_center_id=wc_cut.id,
                sequence=10,
                operation_name="Laser Cut Enclosure Shell",
                duration_minutes=120.0,
                planned_start=now,
                planned_end=now + timedelta(hours=2),
                status="RUNNING"
            ),
            ScheduledOperation(
                production_order_id=po1.id,
                machine_id=machines[2].id,  # CNC-01
                work_center_id=wc_cnc.id,
                sequence=20,
                operation_name="Precision Milling & Tapping",
                duration_minutes=180.0,
                planned_start=now + timedelta(hours=2),
                planned_end=now + timedelta(hours=5),
                status="SCHEDULED"
            ),
            ScheduledOperation(
                production_order_id=po1.id,
                machine_id=machines[5].id,  # ASY-01
                work_center_id=wc_assy.id,
                sequence=30,
                operation_name="Wire Loom & Bracket Assembly",
                duration_minutes=150.0,
                planned_start=now + timedelta(hours=5),
                planned_end=now + timedelta(hours=7, minutes=30),
                status="SCHEDULED"
            ),
            ScheduledOperation(
                production_order_id=po2.id,
                machine_id=machines[3].id,  # CNC-02
                work_center_id=wc_cnc.id,
                sequence=10,
                operation_name="Hydraulic Casing Milling",
                duration_minutes=240.0,
                planned_start=now + timedelta(hours=1),
                planned_end=now + timedelta(hours=5),
                status="SCHEDULED"
            ),
        ])

        await db.commit()
        print("Master Enterprise Database successfully seeded!")


if __name__ == "__main__":
    asyncio.run(seed())
