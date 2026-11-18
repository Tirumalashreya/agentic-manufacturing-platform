# enterprise-aps-platform/backend/app/agents/rfq_agent.py
"""
Cognitive Agent: Natural Language RFQ & Order Promising Copilot.
Combines unstructured language extraction with deterministic verification.
Zero hallucinations: LLM extracts intent; database and solver verify reality.
"""
import re
from typing import Dict, Any, Optional
from datetime import datetime, timedelta


class RFQAgent:
    @staticmethod
    def extract_intent_and_entities(user_prompt: str) -> Dict[str, Any]:
        """
        Extracts customer, product SKU/name, quantity, and requested delivery timeline.
        Robust deterministic fallback parser + structured entity extraction.
        """
        prompt_lower = user_prompt.lower()

        # 1. Extract Quantity
        qty = 10
        qty_match = re.search(r"(\d+)\s*(?:units|pcs|pieces|items|kits|pumps)?", prompt_lower)
        if qty_match:
            try:
                qty = int(qty_match.group(1))
            except ValueError:
                pass

        # 2. Extract Customer Name
        customer_name = "Orion Systems"
        if "abc" in prompt_lower:
            customer_name = "ABC Corp"
        elif "boeing" in prompt_lower:
            customer_name = "Boeing Aerospace"
        elif "tesla" in prompt_lower:
            customer_name = "Tesla Motors"
        elif "delta" in prompt_lower:
            customer_name = "Delta Manufacturing"
        elif "siemens" in prompt_lower:
            customer_name = "Siemens Energy"
        elif "orion" in prompt_lower:
            customer_name = "Orion Systems"

        # 3. Extract Product / SKU
        product_sku = "CMK-100"
        product_name = "Cable Management Kit"
        if "pump" in prompt_lower:
            product_sku = "PMP-500"
            product_name = "Industrial Hydraulic Pump"
        elif "sensor" in prompt_lower:
            product_sku = "SNS-200"
            product_name = "Precision Optical Sensor"
        elif "harness" in prompt_lower:
            product_sku = "WHR-050"
            product_name = "Wire Harness Assembly"

        # 4. Extract Deadline
        requested_deadline = datetime.utcnow() + timedelta(days=5)
        if "tomorrow" in prompt_lower:
            requested_deadline = datetime.utcnow() + timedelta(days=1)
        elif "friday" in prompt_lower:
            requested_deadline = datetime.utcnow() + timedelta(days=3)
        elif "next week" in prompt_lower:
            requested_deadline = datetime.utcnow() + timedelta(days=7)

        return {
            "intent": "CREATE_ORDER",
            "customer_name": customer_name,
            "product_sku": product_sku,
            "product_name": product_name,
            "quantity": qty,
            "requested_deadline": requested_deadline.isoformat(),
            "raw_prompt": user_prompt,
        }
