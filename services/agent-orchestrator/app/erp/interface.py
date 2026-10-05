# app/erp/interface.py
from abc import ABC, abstractmethod


class ERPAdapter(ABC):
    """
    The boundary between this system's workflow/orchestration layer and
    whatever system actually owns customer/product/vendor master data,
    inventory levels, and the core transactional documents (sales
    orders, purchase orders, deliveries, invoices, production orders).

    Deliberately scoped to ONLY those operations — not every function in
    app/tools/. Business-process state this system itself invented and
    owns (Projects, Milestones, Export Orders, Consignments, Financial
    Adjustments, Trading Orders, Service Orders, Subscriptions,
    approvals, audit events, idempotency records) is not ERP data and
    stays out of this interface. A real SAP/Oracle/Dynamics system has
    no native concept of a "Project Milestone" the way it does have a
    native concept of a Customer or a Sales Order — those stay owned by
    this system regardless of which ERP it talks to for the rest.

    One implementation exists today: MockERPAdapter, delegating to the
    existing openpyxl-backed tools/*.py functions with zero behavior
    change. A second implementation (a real SAP/Oracle/Dynamics adapter)
    is what actually makes this interface pay for itself — until one
    exists, this is the seam, not the whole story, and it should stay
    exactly this size until a real second backend needs more of it.
    """

    # --- Master data (reads) ---

    @abstractmethod
    def get_customer(self, customer_name: str) -> dict | None: ...

    @abstractmethod
    def create_customer(self, customer_name: str) -> dict: ...

    @abstractmethod
    def get_product(self, product_name: str | None) -> dict | None: ...

    @abstractmethod
    def get_all_product_names(self) -> list[str]: ...

    @abstractmethod
    def get_stock(self, product_id: str) -> list[dict]: ...

    @abstractmethod
    def get_vendors_for_component(self, component_id: str) -> list[dict]: ...

    @abstractmethod
    def get_vendors_for_product(self, product_id: str) -> list[dict]: ...

    @abstractmethod
    def check_material_availability(self, product_id: str, quantity: int) -> dict: ...

    # --- Credit ---

    @abstractmethod
    def check_credit(
        self,
        customer_id: str | None,
        credit_limit: float | None,
        new_order_amount: float,
        exclude_sales_order_id: str | None = None,
    ) -> dict: ...

    # --- Core transactions (writes) ---

    @abstractmethod
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
    ) -> dict: ...

    @abstractmethod
    def reserve_stock(
        self,
        sales_order_id: str | None,
        product_id: str,
        product_name: str,
        quantity: int,
    ) -> dict: ...

    @abstractmethod
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
    ) -> dict: ...

    @abstractmethod
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
    ) -> dict: ...

    @abstractmethod
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
    ) -> dict: ...

    @abstractmethod
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
    ) -> dict: ...

    @abstractmethod
    def mark_invoice_paid(self, invoice_id: str) -> dict: ...
