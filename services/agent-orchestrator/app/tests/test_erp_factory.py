# app/tests/test_erp_factory.py
"""Fully deterministic. Proves the ERP_BACKEND switch itself, and that
"mock" (the default) never requires any SAP configuration at all."""
import pytest

from app.erp.factory import get_erp_adapter
from app.erp.mock_erp_adapter import MockERPAdapter


def test_default_backend_is_mock(monkeypatch):
    monkeypatch.setattr("app.config.ERP_BACKEND", "mock")

    adapter = get_erp_adapter()

    assert isinstance(adapter, MockERPAdapter)


def test_sap_backend_without_config_raises_not_configured(monkeypatch):
    monkeypatch.setattr("app.config.ERP_BACKEND", "sap")
    monkeypatch.setattr("app.config.SAP_BASE_URL", None)

    from app.erp.sap.errors import ERPNotConfiguredError

    with pytest.raises(ERPNotConfiguredError):
        get_erp_adapter()


def test_unknown_backend_raises_value_error(monkeypatch):
    monkeypatch.setattr("app.config.ERP_BACKEND", "oracle")

    with pytest.raises(ValueError, match="oracle"):
        get_erp_adapter()
