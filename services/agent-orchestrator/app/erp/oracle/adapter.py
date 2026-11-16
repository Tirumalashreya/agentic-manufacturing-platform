# app/erp/oracle/adapter.py
"""
Oracle Fusion Cloud SCM ERPAdapter implementation.
Connects this platform's O2C & APS engine with Oracle Fusion Order Management
via the standard Order Hub REST API:
/fscmRestApi/resources/11.13.18.05/salesOrdersForOrderHub

Requires ORACLE_BASE_URL, ORACLE_USERNAME, ORACLE_PASSWORD, and ORACLE_BUSINESS_UNIT.
When ORACLE_DRY_RUN=true, validates payload generation without dispatching remote HTTP mutation.
"""
import httpx
from app import config
from app.erp.interface import ERPAdapter


class OracleERPNotConfiguredError(RuntimeError):
    pass


class OracleAdapter(ERPAdapter):
    def __init__(self):
        if not (config.ORACLE_BASE_URL and config.ORACLE_USERNAME and config.ORACLE_PASSWORD):
            raise OracleERPNotConfiguredError(
                "ERP_BACKEND=oracle but ORACLE_BASE_URL/ORACLE_USERNAME/ORACLE_PASSWORD are not all "
                "configured in the environment. Set them or use ERP_BACKEND=mock."
            )
        self.base_url = config.ORACLE_BASE_URL.rstrip("/")
        self.auth = (config.ORACLE_USERNAME, config.ORACLE_PASSWORD)
        self.business_unit = config.ORACLE_BUSINESS_UNIT or "Vision Operations"
        self.timeout = config.ORACLE_TIMEOUT_SECONDS
        self.dry_run = config.ORACLE_DRY_RUN

    def create_sales_order(
        self,
        customer_id: str | None,
        customer_name: str | None,
        customer_active: bool,
        product_id: str | None,
        product_name: str | None,
        quantity: int | None,
        unit_price: float | None,
        requested_deadline: str | None,
        idempotency_key: str | None = None,
    ) -> dict:
        if not customer_active:
            return {"created": False, "reason": f"Customer '{customer_name}' is inactive in Oracle SCM."}
        if quantity is None or quantity <= 0:
            return {"created": False, "reason": "Quantity must be greater than zero."}

        # Build Oracle Fusion SCM SalesOrder payload structure
        payload = {
            "BusinessUnitName": self.business_unit,
            "BuyingPartyName": customer_name,
            "CustomerPONumber": idempotency_key or f"CUST-PO-{customer_id}",
            "RequestedShipDate": requested_deadline,
            "lines": [
                {
                    "ProductNumber": product_id or product_name,
                    "OrderedQuantity": quantity,
                    "UnitSellingPrice": unit_price or 0.0,
                }
            ],
        }

        if self.dry_run:
            return {
                "created": True,
                "sales_order_id": f"ORA-DRY-{idempotency_key or '001'}",
                "status": "DRAFT",
                "total_amount": round((unit_price or 0.0) * quantity, 2),
                "dry_run": True,
                "note": "Oracle dry-run payload generated and validated.",
            }

        endpoint = f"{self.base_url}/fscmRestApi/resources/11.13.18.05/salesOrdersForOrderHub"
        headers = {"Content-Type": "application/vnd.oracle.adf.resourceitem+json"}

        try:
            with httpx.Client(auth=self.auth, timeout=self.timeout) as client:
                res = client.post(endpoint, json=payload, headers=headers)
                if res.status_code in (200, 201):
                    data = res.json()
                    order_number = str(data.get("OrderNumber", data.get("HeaderId", "ORA-ORDER")))
                    return {
                        "created": True,
                        "sales_order_id": order_number,
                        "status": "ENTERED",
                        "total_amount": round((unit_price or 0.0) * quantity, 2),
                    }
                return {
                    "created": False,
                    "reason": f"Oracle Cloud rejected order creation (HTTP {res.status_code}): {res.text[:200]}",
                }
        except Exception as exc:
            return {"created": False, "reason": f"Oracle Cloud connection failure: {exc}"}

    def get_customer(self, customer_name: str) -> dict | None:
        raise NotImplementedError("OracleAdapter: get_customer requires Oracle TCA Customer REST API.")

    def create_customer(self, customer_name: str) -> dict:
        raise NotImplementedError("OracleAdapter: create_customer requires Oracle TCA Customer REST API.")

    def get_product(self, product_name: str | None) -> dict | None:
        raise NotImplementedError("OracleAdapter: get_product requires Oracle Product Hub (PIM) REST API.")

    def get_all_product_names(self) -> list[str]:
        raise NotImplementedError("OracleAdapter: get_all_product_names requires Oracle Product Hub REST API.")

    def get_stock(self, product_id: str) -> list[dict]:
        raise NotImplementedError("OracleAdapter: get_stock requires Oracle Inventory Management REST API.")

    def get_vendors_for_component(self, component_id: str) -> list[dict]:
        raise NotImplementedError("OracleAdapter: get_vendors_for_component requires Oracle Procurement REST API.")

    def get_vendors_for_product(self, product_id: str) -> list[dict]:
        raise NotImplementedError("OracleAdapter: get_vendors_for_product requires Oracle Procurement REST API.")

    def check_material_availability(self, product_id: str, quantity: int) -> dict:
        raise NotImplementedError("OracleAdapter: check_material_availability requires Oracle SCM GOP REST API.")

    def check_credit(self, customer_id: str | None, credit_limit: float | None, new_order_amount: float, exclude_sales_order_id: str | None = None) -> dict:
        raise NotImplementedError("OracleAdapter: check_credit requires Oracle Credit Management REST API.")

    def reserve_stock(self, sales_order_id: str | None, product_id: str, product_name: str, quantity: int, idempotency_key: str | None = None) -> dict:
        raise NotImplementedError("OracleAdapter: reserve_stock requires Oracle Inventory Reservation API.")

    def create_production_order(self, sales_order_id: str | None, product_id: str, product_name: str, quantity: int, lead_time_days: int | None, requires_configuration: bool = False, configuration_notes: str | None = None, initial_status: str = "PLANNED") -> dict:
        raise NotImplementedError("OracleAdapter: create_production_order requires Oracle Manufacturing Work Order API.")

    def create_purchase_order(self, production_order_id: str, component_id: str, component_name: str, vendor_id: str, vendor_name: str, quantity: int, unit_cost: float, lead_time_days: int, idempotency_key: str | None = None) -> dict:
        raise NotImplementedError("OracleAdapter: create_purchase_order requires Oracle Purchasing REST API.")

    def create_delivery(self, sales_order_id: str | None, customer_id: str | None, customer_name: str | None, product_id: str, product_name: str, quantity: int, requested_delivery_date: str | None = None, idempotency_key: str | None = None) -> dict:
        raise NotImplementedError("OracleAdapter: create_delivery requires Oracle Shipping REST API.")

    def create_invoice(self, sales_order_id: str | None, delivery_id: str | None, customer_id: str | None, customer_name: str | None, quantity_billed: int, unit_price: float, payment_terms_days: int, notes: str, idempotency_key: str | None = None) -> dict:
        raise NotImplementedError("OracleAdapter: create_invoice requires Oracle Receivables (AR) REST API.")

    def mark_invoice_paid(self, invoice_id: str) -> dict:
        raise NotImplementedError("OracleAdapter: mark_invoice_paid requires Oracle Receivables Cash Receipts API.")
