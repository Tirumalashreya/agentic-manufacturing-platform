# enterprise-aps-platform/backend/app/solver/mrp_engine.py
"""
Deterministic Multi-Level Material Requirements Planning (MRP) Engine (SAP MD01N / Oracle Supply Planning).
Performs recursive Bill of Materials (BOM) explosion across all active demand signals (Sales Orders & Production Orders),
evaluates on-hand stock and safety stock thresholds, and autonomously generates Purchase Requisitions (ME21N) for shortages.
"""
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional
import math
import uuid


class MultiLevelMRPEngine:
    @staticmethod
    def explode_and_calculate(
        demand_orders: List[Dict[str, Any]],
        materials_by_id: Dict[str, Any],
        materials_by_sku: Dict[str, Any],
        boms_by_material_id: Dict[str, Any],
        open_pos_by_material_id: Dict[str, float],
        suppliers_by_material_sku: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Executes multi-level BOM explosion and calculates net requirements.
        Deterministic: No LLM hallucination in arithmetic or stock balances.
        """
        gross_requirements: Dict[str, float] = {}  # material_id -> total gross quantity
        pegged_orders: Dict[str, List[str]] = {}   # material_id -> list of sales/production order numbers
        component_levels: Dict[str, int] = {}      # material_id -> max BOM level

        # 1. Recursive BOM Explosion
        def explode_material(parent_mat_id: str, multiplier: float, level: int, order_ref: str):
            bom = boms_by_material_id.get(parent_mat_id)
            if not bom or not bom.get("items"):
                return

            for item in bom["items"]:
                comp_id = item["component_material_id"]
                scrap = 1.0 + (item.get("scrap_factor_pct", 0.0) / 100.0)
                qty_needed = multiplier * item["quantity_per"] * scrap

                gross_requirements[comp_id] = gross_requirements.get(comp_id, 0.0) + qty_needed

                if comp_id not in pegged_orders:
                    pegged_orders[comp_id] = []
                if order_ref not in pegged_orders[comp_id]:
                    pegged_orders[comp_id].append(order_ref)

                component_levels[comp_id] = max(component_levels.get(comp_id, 1), level)

                # Recursive explosion for multi-level subassemblies
                explode_material(comp_id, qty_needed, level + 1, order_ref)

        # Process each demand order
        for demand in demand_orders:
            mat_id = demand.get("material_id")
            order_qty = demand.get("quantity", 0.0)
            order_ref = demand.get("order_number", "DEMAND-REF")
            if mat_id and order_qty > 0:
                explode_material(mat_id, order_qty, 1, order_ref)

        # 2. Net Requirements Calculation (Gross - OnHand - Inbound + SafetyStock)
        mrp_items = []
        generated_prs = []
        shortage_count = 0
        total_shortage_value = 0.0
        now = datetime.utcnow()

        pr_counter = 1
        for comp_id, gross_req in gross_requirements.items():
            material = materials_by_id.get(comp_id)
            if not material:
                continue

            on_hand = float(material.get("current_stock", 0.0))
            safety_stock = float(material.get("safety_stock", 0.0))
            inbound_po_qty = float(open_pos_by_material_id.get(comp_id, 0.0))
            standard_cost = float(material.get("standard_cost", 0.0))

            # Available stock = On-Hand + Open Inbound POs
            effective_available = on_hand + inbound_po_qty
            # Net requirement formula: max(0, Gross Requirement + Safety Stock - Available)
            net_req = max(0.0, round((gross_req + safety_stock) - effective_available, 2))

            has_shortage = net_req > 0.0
            if has_shortage:
                shortage_count += 1
                shortage_cost = round(net_req * standard_cost, 2)
                total_shortage_value += shortage_cost

                # Preferred Supplier Lookup
                supplier_info = suppliers_by_material_sku.get(material["sku"]) or {
                    "code": "VEND-GEN",
                    "name": "Certified Tier-1 Aerospace Vendor",
                    "lead_time_days": 7,
                    "rating": "TIER_1",
                    "unit_cost": standard_cost,
                }

                # Dock Due Date: Needed before manufacturing schedule start
                lead_days = supplier_info.get("lead_time_days", 7)
                dock_due_date = now + timedelta(days=max(3, lead_days))

                generated_prs.append({
                    "pr_number": f"PR-{now.strftime('%Y%m')}-{uuid.uuid4().hex[:6].upper()}",
                    "material_id": material["id"],
                    "material_sku": material["sku"],
                    "material_name": material["name"],
                    "quantity": net_req,
                    "unit_cost": standard_cost,
                    "total_amount": shortage_cost,
                    "supplier_code": supplier_info["code"],
                    "supplier_name": supplier_info["name"],
                    "lead_time_days": lead_days,
                    "dock_due_date": dock_due_date.isoformat(),
                    "pegged_orders": pegged_orders.get(comp_id, []),
                    "status": "DRAFT_PR"
                })
                pr_counter += 1

            mrp_items.append({
                "material_id": material["id"],
                "sku": material["sku"],
                "name": material["name"],
                "material_type": material.get("material_type", "RAW"),
                "bom_level": component_levels.get(comp_id, 1),
                "gross_requirement": round(gross_req, 2),
                "on_hand_stock": round(on_hand, 2),
                "safety_stock": round(safety_stock, 2),
                "inbound_pipeline": round(inbound_po_qty, 2),
                "net_requirement": net_req,
                "unit_cost": standard_cost,
                "total_shortage_value": round(net_req * standard_cost, 2),
                "pegged_orders": pegged_orders.get(comp_id, []),
                "status": "SHORTAGE_DETECTED" if has_shortage else "HEALTHY",
            })

        # Sort items: Shortages first, then by BOM level
        mrp_items.sort(key=lambda x: (0 if x["status"] == "SHORTAGE_DETECTED" else 1, x["bom_level"]))

        # 3. Cognitive Risk Evaluation Summary
        lead_time_risks = [pr for pr in generated_prs if pr["lead_time_days"] > 7]

        return {
            "run_timestamp": now.isoformat(),
            "demand_orders_count": len(demand_orders),
            "components_analyzed": len(mrp_items),
            "shortages_detected_count": shortage_count,
            "total_shortage_capital_needed": round(total_shortage_value, 2),
            "generated_purchase_requisitions": generated_prs,
            "items": mrp_items,
            "cognitive_risk_summary": {
                "critical_shortages": shortage_count,
                "high_lead_time_items": len(lead_time_risks),
                "recommendation": (
                    f"Approved release of {len(generated_prs)} Purchase Requisition(s) recommended to protect customer CTP dates. "
                    f"Expedited dock receiving suggested for {lead_time_risks[0]['material_sku'] if lead_time_risks else 'all shortage items'}."
                ) if shortage_count > 0 else "All materials healthy. Available stock and pipeline fully cover active manufacturing demand."
            }
        }
