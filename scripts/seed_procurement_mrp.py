# enterprise-aps-platform/scripts/seed_procurement_mrp.py
import asyncio
import sys
import os
from datetime import datetime, timedelta
from sqlalchemy import select

# Add backend to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from app.core.database import AsyncSessionLocal, init_db
from app.models.master_data import Material, BillOfMaterial, BOMItem
from app.models.procurement import Supplier, PurchaseOrder


async def seed_procurement_mrp():
    print("Ensuring tables exist...")
    await init_db()

    async with AsyncSessionLocal() as db:
        print("Checking & seeding certified suppliers...")
        existing_suppliers = await db.execute(select(Supplier))
        if not existing_suppliers.scalars().first():
            suppliers = [
                Supplier(
                    code="VEND-ALLEGHENY",
                    name="Allegheny Technologies (ATI Special Metals)",
                    rating="STRATEGIC",
                    lead_time_days=8,
                    on_time_delivery_pct=98.4,
                    country="USA",
                    contact_email="defense.orders@atimaterials.com"
                ),
                Supplier(
                    code="VEND-SPS",
                    name="SPS Fastener Technologies",
                    rating="TIER_1",
                    lead_time_days=4,
                    on_time_delivery_pct=99.6,
                    country="USA",
                    contact_email="sales@spstech.com"
                ),
                Supplier(
                    code="VEND-PARKER",
                    name="Parker Hannifin Aerospace Fluid Connectors",
                    rating="TIER_1",
                    lead_time_days=6,
                    on_time_delivery_pct=97.9,
                    country="USA",
                    contact_email="aerospace.orders@parker.com"
                ),
                Supplier(
                    code="VEND-SKF",
                    name="SKF Precision Aerospace Bearings",
                    rating="STRATEGIC",
                    lead_time_days=10,
                    on_time_delivery_pct=98.8,
                    country="Sweden",
                    contact_email="aero.precision@skf.com"
                ),
            ]
            db.add_all(suppliers)
            await db.flush()
            print("Seeded 4 certified suppliers.")

        # Check BOM for PMP-500
        pmp_res = await db.execute(select(Material).where(Material.sku == "PMP-500"))
        mat_pmp = pmp_res.scalar_one_or_none()
        if mat_pmp:
            bom_pmp_check = await db.execute(select(BillOfMaterial).where(BillOfMaterial.finished_material_id == mat_pmp.id))
            if not bom_pmp_check.scalar_one_or_none():
                bom_pmp = BillOfMaterial(finished_material_id=mat_pmp.id, version="3.0", active=True)
                db.add(bom_pmp)
                await db.flush()

                # Components
                stl_res = await db.execute(select(Material).where(Material.sku == "RAW-STL-01"))
                mat_stl = stl_res.scalar_one_or_none()
                fst_res = await db.execute(select(Material).where(Material.sku == "RAW-FST-02"))
                mat_fst = fst_res.scalar_one_or_none()
                wir_res = await db.execute(select(Material).where(Material.sku == "RAW-WIR-03"))
                mat_wir = wir_res.scalar_one_or_none()

                if mat_stl and mat_fst:
                    db.add_all([
                        BOMItem(bom_id=bom_pmp.id, component_material_id=mat_stl.id, quantity_per=5.0, scrap_factor_pct=3.0),
                        BOMItem(bom_id=bom_pmp.id, component_material_id=mat_fst.id, quantity_per=16.0, scrap_factor_pct=0.5),
                    ])
                    if mat_wir:
                        db.add(BOMItem(bom_id=bom_pmp.id, component_material_id=mat_wir.id, quantity_per=2.0, scrap_factor_pct=1.0))
                    print("Seeded BOM for PMP-500.")

        # Check BOM for SNS-200
        sns_res = await db.execute(select(Material).where(Material.sku == "SNS-200"))
        mat_sns = sns_res.scalar_one_or_none()
        if mat_sns:
            bom_sns_check = await db.execute(select(BillOfMaterial).where(BillOfMaterial.finished_material_id == mat_sns.id))
            if not bom_sns_check.scalar_one_or_none():
                bom_sns = BillOfMaterial(finished_material_id=mat_sns.id, version="1.5", active=True)
                db.add(bom_sns)
                await db.flush()

                stl_res = await db.execute(select(Material).where(Material.sku == "RAW-STL-01"))
                mat_stl = stl_res.scalar_one_or_none()
                fst_res = await db.execute(select(Material).where(Material.sku == "RAW-FST-02"))
                mat_fst = fst_res.scalar_one_or_none()
                wir_res = await db.execute(select(Material).where(Material.sku == "RAW-WIR-03"))
                mat_wir = wir_res.scalar_one_or_none()

                if mat_stl and mat_fst and mat_wir:
                    db.add_all([
                        BOMItem(bom_id=bom_sns.id, component_material_id=mat_stl.id, quantity_per=1.2, scrap_factor_pct=1.0),
                        BOMItem(bom_id=bom_sns.id, component_material_id=mat_fst.id, quantity_per=6.0, scrap_factor_pct=0.5),
                        BOMItem(bom_id=bom_sns.id, component_material_id=mat_wir.id, quantity_per=3.5, scrap_factor_pct=1.0),
                    ])
                    print("Seeded BOM for SNS-200.")

        # Check initial sample purchase orders
        po_check = await db.execute(select(PurchaseOrder))
        if not po_check.scalars().first():
            supp_res = await db.execute(select(Supplier).where(Supplier.code == "VEND-ALLEGHENY"))
            supp_allegheny = supp_res.scalar_one_or_none()
            stl_res = await db.execute(select(Material).where(Material.sku == "RAW-STL-01"))
            mat_stl = stl_res.scalar_one_or_none()

            if supp_allegheny and mat_stl:
                sample_po = PurchaseOrder(
                    po_number="PO-VEND-202611-0010",
                    supplier_id=supp_allegheny.id,
                    material_id=mat_stl.id,
                    quantity=500.0,
                    unit_cost=45.0,
                    total_amount=22500.0,
                    status="RELEASED",
                    dock_due_date=datetime.utcnow() + timedelta(days=6)
                )
                db.add(sample_po)
                print("Seeded sample in-transit purchase order.")

        await db.commit()
        print("Procurement & Multi-Level MRP seeding complete!")


if __name__ == "__main__":
    asyncio.run(seed_procurement_mrp())
