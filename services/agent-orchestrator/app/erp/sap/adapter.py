# app/erp/sap/adapter.py
"""
Phase 5 (agreed with the user): the second real ERPAdapter
implementation. Scoped honestly to what this session actually
researched from real SAP documentation — the Sales Order (A2X, OData V2)
create operation — not to all 14 interface methods. get_customer,
get_product, get_stock, check_credit, and the rest each need their own
separate real SAP API (Business Partner, Product Master, ATP, Credit
Management) that this session did not research from real docs; rather
than fabricate plausible-looking field mappings for APIs nobody has
actually looked at, they raise NotImplementedError with a clear message.
That is a deliberate, honest scope boundary, not an oversight — see
SAP_INTEGRATION.md.

Requires SAP_BASE_URL/SAP_USERNAME/SAP_PASSWORD to be configured;
raises ERPNotConfiguredError otherwise instead of silently doing nothing
or fabricating a result. SAP_DRY_RUN=true builds and validates the real
payload without ever sending the create request.
"""
from app import config
from app.erp.interface import ERPAdapter
from app.erp.sap.client import SAPODataClient
from app.erp.sap.errors import ERPNotConfiguredError, ERPTimeoutError
from app.erp.sap.mapper import SAPSalesAreaConfig, build_sales_order_payload, parse_sales_order_response

# The one real operation this adapter implements — see module docstring.
SALES_ORDER_PATH = "/A_SalesOrder"


class SAPAdapter(ERPAdapter):
    def __init__(self):
        if not (config.SAP_BASE_URL and config.SAP_USERNAME and config.SAP_PASSWORD):
            raise ERPNotConfiguredError(
                "ERP_BACKEND=sap but SAP_BASE_URL/SAP_USERNAME/SAP_PASSWORD are not all "
                "set. Configure them, or set ERP_BACKEND=mock to use the mock ERP."
            )
        self._client = SAPODataClient(
            config.SAP_BASE_URL, config.SAP_USERNAME, config.SAP_PASSWORD, config.SAP_TIMEOUT_SECONDS
        )
        self._sales_area = SAPSalesAreaConfig(
            sales_organization=config.SAP_SALES_ORGANIZATION,
            distribution_channel=config.SAP_DISTRIBUTION_CHANNEL,
            organization_division=config.SAP_ORGANIZATION_DIVISION,
            sales_order_type=config.SAP_SALES_ORDER_TYPE,
            transaction_currency=config.SAP_TRANSACTION_CURRENCY,
        )

    # --- implemented ---

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
        # Same guard MockERPAdapter's underlying create_sales_order()
        # tool enforces — kept here too so a caller gets the same honest
        # rejection shape regardless of backend, before any SAP call
        # (and before spending a CSRF round-trip) is attempted.
        if customer_id is None or not customer_active:
            return {"created": False, "reason": "Cannot create a sales order for an unknown or inactive customer."}
        if product_id is None or unit_price is None:
            return {"created": False, "reason": "Cannot create a sales order without a valid product and price."}
        if quantity is None or quantity <= 0:
            return {"created": False, "reason": "Cannot create a sales order without a valid quantity."}

        payload = build_sales_order_payload(
            self._sales_area, customer_id=customer_id, product_id=product_id, quantity=quantity,
        )

        if config.SAP_DRY_RUN:
            return {
                "created": False,
                "reason": (
                    "SAP_DRY_RUN is enabled — payload built and validated but not sent. "
                    f"Would POST {SALES_ORDER_PATH}: {payload!r}"
                ),
            }

        # A timeout here means SAP's real-world outcome is genuinely
        # unknown (it may have committed the order before the response
        # was lost) — this must NOT be silently retried by this adapter.
        # See SAP_INTEGRATION.md's idempotency note; the caller decides
        # what to do with an ERPTimeoutError, this method never guesses.
        try:
            response_body = self._client.post(SALES_ORDER_PATH, json=payload)
        except ERPTimeoutError:
            raise

        return parse_sales_order_response(response_body, quantity=quantity, unit_price=unit_price)

    # --- not yet implemented (see module docstring) ---

    def _not_implemented(self, method_name: str) -> None:
        raise NotImplementedError(
            f"SAPAdapter.{method_name}() is not implemented. Phase 5's scope this session "
            f"was limited to create_sales_order (the only operation with real SAP "
            f"documentation researched) — {method_name} needs its own real SAP API "
            f"research (Business Partner / Product Master / ATP / Credit Management APIs, "
            f"as applicable) before it can be built honestly. See SAP_INTEGRATION.md."
        )

    def get_customer(self, customer_name):
        self._not_implemented("get_customer")

    def create_customer(self, customer_name):
        self._not_implemented("create_customer")

    def get_product(self, product_name):
        self._not_implemented("get_product")

    def get_all_product_names(self):
        self._not_implemented("get_all_product_names")

    def get_stock(self, product_id):
        self._not_implemented("get_stock")

    def get_vendors_for_component(self, component_id):
        self._not_implemented("get_vendors_for_component")

    def get_vendors_for_product(self, product_id):
        self._not_implemented("get_vendors_for_product")

    def check_material_availability(self, product_id, quantity):
        self._not_implemented("check_material_availability")

    def check_credit(self, customer_id, credit_limit, new_order_amount, exclude_sales_order_id=None):
        self._not_implemented("check_credit")

    def reserve_stock(self, sales_order_id, product_id, product_name, quantity):
        self._not_implemented("reserve_stock")

    def create_production_order(
        self, sales_order_id, product_id, product_name, quantity, lead_time_days,
        requires_configuration=False, configuration_notes=None, initial_status="PLANNED",
    ):
        self._not_implemented("create_production_order")

    def create_purchase_order(
        self, production_order_id, component_id, component_name, vendor_id, vendor_name,
        quantity, unit_cost, lead_time_days, idempotency_key=None,
    ):
        self._not_implemented("create_purchase_order")

    def create_delivery(
        self, sales_order_id, customer_id, customer_name, product_id, product_name,
        quantity, requested_delivery_date=None, idempotency_key=None,
    ):
        self._not_implemented("create_delivery")

    def create_invoice(
        self, sales_order_id, delivery_id, customer_id, customer_name, quantity_billed,
        unit_price, payment_terms_days, notes, idempotency_key=None,
    ):
        self._not_implemented("create_invoice")

    def mark_invoice_paid(self, invoice_id):
        self._not_implemented("mark_invoice_paid")
