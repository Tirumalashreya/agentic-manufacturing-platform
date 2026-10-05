# app/erp/sap/mapper.py
"""
The ONLY place SAP field names live. Maps this system's plain
create_sales_order() parameters onto the SAP Sales Order (A2X, OData V2)
create payload, and maps SAP's create response back onto the exact same
plain result shape MockERPAdapter.create_sales_order() already returns —
so the business layer genuinely cannot tell which backend it's talking
to.

Fails loudly (ERPValidationError) on missing tenant-specific
configuration or unresolved customer/product, rather than guessing a
sales organization/order type/division that could silently misfile a
real order in a real tenant. None of these values are ever invented here.
"""
from app.erp.sap.errors import ERPValidationError


class SAPSalesAreaConfig:
    """Tenant-specific values a real SAP system requires to file a sales
    order — read from environment config (app/config.py), never guessed."""

    def __init__(
        self,
        sales_organization: str | None,
        distribution_channel: str | None,
        organization_division: str | None,
        sales_order_type: str | None,
        transaction_currency: str,
    ):
        self.sales_organization = sales_organization
        self.distribution_channel = distribution_channel
        self.organization_division = organization_division
        self.sales_order_type = sales_order_type
        self.transaction_currency = transaction_currency

    def missing_fields(self) -> list[str]:
        return [
            name
            for name, value in [
                ("SAP_SALES_ORGANIZATION", self.sales_organization),
                ("SAP_DISTRIBUTION_CHANNEL", self.distribution_channel),
                ("SAP_ORGANIZATION_DIVISION", self.organization_division),
                ("SAP_SALES_ORDER_TYPE", self.sales_order_type),
            ]
            if not value
        ]


def build_sales_order_payload(
    sales_area: SAPSalesAreaConfig,
    *,
    customer_id: str | None,
    product_id: str | None,
    quantity: int | None,
) -> dict:
    missing = sales_area.missing_fields()
    if missing:
        raise ERPValidationError(
            f"SAP sales-area configuration is missing: {', '.join(missing)}. "
            f"These are tenant-specific (set by a real SAP environment/communication "
            f"arrangement) and are never guessed by this adapter."
        )
    if not customer_id:
        raise ERPValidationError(
            "Cannot build a SAP sales order without a resolved customer_id — SAP's "
            "SoldToParty must be a real Business Partner number from this tenant, "
            "not this system's own mock customer id."
        )
    if not product_id:
        raise ERPValidationError(
            "Cannot build a SAP sales order without a resolved product_id — SAP's "
            "Material must be a real material number from this tenant, not this "
            "system's own mock product id."
        )
    if not quantity or quantity <= 0:
        raise ERPValidationError("Cannot build a SAP sales order without a valid quantity.")

    return {
        "SalesOrderType": sales_area.sales_order_type,
        "SalesOrganization": sales_area.sales_organization,
        "DistributionChannel": sales_area.distribution_channel,
        "OrganizationDivision": sales_area.organization_division,
        "SoldToParty": customer_id,
        "TransactionCurrency": sales_area.transaction_currency,
        "to_Item": [
            {
                "SalesOrderItem": "10",
                "Material": product_id,
                "RequestedQuantity": str(quantity),
                "RequestedQuantityUnit": "EA",
            }
        ],
    }


def parse_sales_order_response(body: dict, *, quantity: int, unit_price: float | None) -> dict:
    """
    SAP's create response ('d' envelope, OData V2 convention) -> the
    exact plain shape MockERPAdapter.create_sales_order() returns:
    {created, sales_order_id, status, total_amount}. total_amount is
    computed from the quantity/unit_price this system already resolved
    and trusts, not extracted from SAP's basic create response — reading
    real SAP-side pricing back would need expanding to_Item/to_Pricing,
    which this adapter doesn't request yet (see SAP_INTEGRATION.md).
    """
    data = body.get("d", body)
    sales_order_id = data.get("SalesOrder")
    if not sales_order_id:
        raise ValueError(f"SAP create response had no SalesOrder id: {body!r}")
    return {
        "created": True,
        "sales_order_id": sales_order_id,
        "status": "CONFIRMED",
        "total_amount": round(quantity * unit_price, 2) if unit_price is not None else None,
    }
