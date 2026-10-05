# app/erp/factory.py
"""
The single switch between ERPAdapter implementations, driven by
ERP_BACKEND (app/config.py). "mock" is the default — every existing
workflow/test runs against it unless ERP_BACKEND=sap is explicitly set.
graph.py and context_agent.py import default_erp_adapter from here now
instead of from mock_erp_adapter directly — that's the only change
Phase 5 makes to those two files.
"""
from app import config
from app.erp.interface import ERPAdapter


def get_erp_adapter() -> ERPAdapter:
    if config.ERP_BACKEND == "sap":
        from app.erp.sap.adapter import SAPAdapter

        return SAPAdapter()
    if config.ERP_BACKEND != "mock":
        raise ValueError(f"Unknown ERP_BACKEND={config.ERP_BACKEND!r} — expected 'mock' or 'sap'.")
    from app.erp.mock_erp_adapter import MockERPAdapter

    return MockERPAdapter()


default_erp_adapter = get_erp_adapter()
