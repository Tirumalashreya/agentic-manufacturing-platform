# app/tests/test_sap_mapper.py
"""Fully deterministic — no network, no LLM. Proves the internal-params
-> SAP-payload mapping and back, and that missing tenant configuration
fails loudly rather than guessing."""
import pytest

from app.erp.sap.errors import ERPValidationError
from app.erp.sap.mapper import SAPSalesAreaConfig, build_sales_order_payload, parse_sales_order_response


def _sales_area(**overrides):
    base = dict(
        sales_organization="1710", distribution_channel="10",
        organization_division="00", sales_order_type="OR", transaction_currency="USD",
    )
    base.update(overrides)
    return SAPSalesAreaConfig(**base)


def test_build_sales_order_payload_happy_path():
    payload = build_sales_order_payload(
        _sales_area(), customer_id="10000123", product_id="TG12", quantity=10,
    )

    assert payload["SalesOrderType"] == "OR"
    assert payload["SalesOrganization"] == "1710"
    assert payload["DistributionChannel"] == "10"
    assert payload["OrganizationDivision"] == "00"
    assert payload["SoldToParty"] == "10000123"
    assert payload["TransactionCurrency"] == "USD"
    assert payload["to_Item"] == [
        {"SalesOrderItem": "10", "Material": "TG12", "RequestedQuantity": "10", "RequestedQuantityUnit": "EA"}
    ]


def test_build_sales_order_payload_rejects_missing_sales_area_config():
    with pytest.raises(ERPValidationError, match="SAP_SALES_ORGANIZATION"):
        build_sales_order_payload(
            _sales_area(sales_organization=None), customer_id="10000123", product_id="TG12", quantity=10,
        )


def test_build_sales_order_payload_rejects_missing_customer():
    with pytest.raises(ERPValidationError, match="customer_id"):
        build_sales_order_payload(_sales_area(), customer_id=None, product_id="TG12", quantity=10)


def test_build_sales_order_payload_rejects_missing_product():
    with pytest.raises(ERPValidationError, match="product_id"):
        build_sales_order_payload(_sales_area(), customer_id="10000123", product_id=None, quantity=10)


def test_build_sales_order_payload_rejects_bad_quantity():
    with pytest.raises(ERPValidationError, match="quantity"):
        build_sales_order_payload(_sales_area(), customer_id="10000123", product_id="TG12", quantity=0)


def test_parse_sales_order_response_maps_to_mock_shape():
    result = parse_sales_order_response({"d": {"SalesOrder": "SO0001"}}, quantity=10, unit_price=800.0)

    assert result == {
        "created": True,
        "sales_order_id": "SO0001",
        "status": "CONFIRMED",
        "total_amount": 8000.0,
    }


def test_parse_sales_order_response_without_unit_price_leaves_total_none():
    result = parse_sales_order_response({"d": {"SalesOrder": "SO0001"}}, quantity=10, unit_price=None)

    assert result["total_amount"] is None


def test_parse_sales_order_response_missing_id_raises():
    with pytest.raises(ValueError):
        parse_sales_order_response({"d": {}}, quantity=10, unit_price=800.0)
