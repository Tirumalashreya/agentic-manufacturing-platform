# app/erp/mock_erp_adapter.py
from app.erp.interface import ERPAdapter
from app.tools.billing_tools import create_invoice as _create_invoice, mark_invoice_paid as _mark_invoice_paid
from app.tools.credit_tools import check_credit as _check_credit
from app.tools.customer_tools import create_customer as _create_customer, get_customer as _get_customer
from app.tools.delivery_tools import create_delivery as _create_delivery
from app.tools.inventory_tools import get_stock as _get_stock
from app.tools.procurement_tools import (
    check_material_availability as _check_material_availability,
    create_purchase_order as _create_purchase_order,
    get_vendors_for_component as _get_vendors_for_component,
)
from app.tools.product_tools import get_all_product_names as _get_all_product_names, get_product as _get_product
from app.tools.production_tools import create_production_order as _create_production_order, reserve_stock as _reserve_stock
from app.tools.sales_tools import create_sales_order as _create_sales_order
from app.tools.trading_tools import get_vendors_for_product as _get_vendors_for_product


# The only implementation of ERPAdapter today — every method is a pure,
# behavior-preserving delegate to the existing tools/*.py functions
# already covered by this codebase's test suite. No logic lives here; if
# a real ERP is ever wired in, its adapter reimplements each of these
# same 14 operations against that ERP's actual API, and nothing above
# this layer (graph.py, the agents) needs to know or care.
class MockERPAdapter(ERPAdapter):
    def get_customer(self, customer_name: str) -> dict | None:
        return _get_customer(customer_name)

    def create_customer(self, customer_name: str) -> dict:
        return _create_customer(customer_name)

    def get_product(self, product_name: str | None) -> dict | None:
        return _get_product(product_name)

    def get_all_product_names(self) -> list[str]:
        return _get_all_product_names()

    def get_stock(self, product_id: str) -> list[dict]:
        return _get_stock(product_id)

    def get_vendors_for_component(self, component_id: str) -> list[dict]:
        return _get_vendors_for_component(component_id)

    def get_vendors_for_product(self, product_id: str) -> list[dict]:
        return _get_vendors_for_product(product_id)

    def check_material_availability(self, product_id: str, quantity: int) -> dict:
        return _check_material_availability(product_id, quantity)

    def check_credit(
        self,
        customer_id: str | None,
        credit_limit: float | None,
        new_order_amount: float,
        exclude_sales_order_id: str | None = None,
    ) -> dict:
        return _check_credit(customer_id, credit_limit, new_order_amount, exclude_sales_order_id)

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
        return _create_sales_order(
            customer_id, customer_name, customer_active, product_id, product_name,
            quantity, unit_price, requested_deadline, idempotency_key=idempotency_key,
        )

    def reserve_stock(
        self,
        sales_order_id: str | None,
        product_id: str,
        product_name: str,
        quantity: int,
    ) -> dict:
        return _reserve_stock(sales_order_id, product_id, product_name, quantity)

    def create_production_order(
        self,
        sales_order_id: str | None,
        product_id: str,
        product_name: str,
        quantity: int,
        lead_time_days: int | None,
        requires_configuration: bool = False,
        configuration_notes: str | None = None,
        initial_status: str = "PLANNED",
    ) -> dict:
        return _create_production_order(
            sales_order_id, product_id, product_name, quantity, lead_time_days,
            requires_configuration=requires_configuration,
            configuration_notes=configuration_notes,
            initial_status=initial_status,
        )

    def create_purchase_order(
        self,
        production_order_id: str,
        component_id: str,
        component_name: str,
        vendor_id: str,
        vendor_name: str,
        quantity: int,
        unit_cost: float,
        lead_time_days: int,
        idempotency_key: str | None = None,
    ) -> dict:
        return _create_purchase_order(
            production_order_id, component_id, component_name, vendor_id, vendor_name,
            quantity, unit_cost, lead_time_days, idempotency_key=idempotency_key,
        )

    def create_delivery(
        self,
        sales_order_id: str | None,
        customer_id: str | None,
        customer_name: str | None,
        product_id: str,
        product_name: str,
        quantity: int,
        requested_delivery_date: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        return _create_delivery(
            sales_order_id, customer_id, customer_name, product_id, product_name,
            quantity, requested_delivery_date=requested_delivery_date, idempotency_key=idempotency_key,
        )

    def create_invoice(
        self,
        sales_order_id: str | None,
        delivery_id: str | None,
        customer_id: str | None,
        customer_name: str | None,
        quantity_billed: int,
        unit_price: float,
        payment_terms_days: int,
        notes: str,
        idempotency_key: str | None = None,
    ) -> dict:
        return _create_invoice(
            sales_order_id, delivery_id, customer_id, customer_name,
            quantity_billed, unit_price, payment_terms_days, notes,
            idempotency_key=idempotency_key,
        )

    def mark_invoice_paid(self, invoice_id: str) -> dict:
        return _mark_invoice_paid(invoice_id)


# One shared instance, imported wherever the workflow layer needs ERP
# access — not a dependency-injection framework, just the single seam
# that would get swapped for a real adapter later.
default_erp_adapter = MockERPAdapter()
