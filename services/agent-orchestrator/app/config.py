# app/config.py
# One place for values every agent needs — change once here instead of in
# every agent file. Groq's hosted model catalog changes over time (this
# exact problem just happened: llama-3.3-70b-versatile got removed), so
# this is the one line to fix next time, not N agent files.
GROQ_MODEL = "openai/gpt-oss-120b"

import os


# Groq's rate limit (tokens/day) is scoped per organization, not per key —
# so spreading agents across separate accounts actually adds capacity,
# unlike generating multiple keys from the same account. Each agent can
# get its own dedicated key (GROQ_API_KEY_<AGENT>); anything without one
# falls back to the shared GROQ_API_KEY, so this works with just one key
# too.
def groq_api_key(agent_name: str) -> str:
    return os.environ.get(f"GROQ_API_KEY_{agent_name.upper()}") or os.environ["GROQ_API_KEY"]


# Phase 5 (agreed with the user): which ERPAdapter implementation the
# business layer talks to. "mock" is the default and what every existing
# test/workflow runs against — switching to "sap" is opt-in, never
# automatic, so local dev and CI keep working with zero SAP access.
ERP_BACKEND = os.environ.get("ERP_BACKEND", "mock")

SAP_BASE_URL = os.environ.get("SAP_BASE_URL")
SAP_USERNAME = os.environ.get("SAP_USERNAME")
SAP_PASSWORD = os.environ.get("SAP_PASSWORD")
SAP_TIMEOUT_SECONDS = float(os.environ.get("SAP_TIMEOUT_SECONDS", "30"))
# When true, SAPAdapter builds and validates the real payload but never
# sends the create request — see app/erp/sap/adapter.py.
SAP_DRY_RUN = os.environ.get("SAP_DRY_RUN", "false").strip().lower() == "true"

# Sales-area/order-type configuration SAP requires to file a Sales Order
# correctly in a given tenant — genuinely tenant-specific (see SAP Help's
# own communication-arrangement/master-data docs), so these are read from
# the environment and never guessed; app/erp/sap/mapper.py fails loudly
# if any are missing rather than fabricating a plausible-looking default.
SAP_SALES_ORGANIZATION = os.environ.get("SAP_SALES_ORGANIZATION")
SAP_DISTRIBUTION_CHANNEL = os.environ.get("SAP_DISTRIBUTION_CHANNEL")
SAP_ORGANIZATION_DIVISION = os.environ.get("SAP_ORGANIZATION_DIVISION")
SAP_SALES_ORDER_TYPE = os.environ.get("SAP_SALES_ORDER_TYPE")
SAP_TRANSACTION_CURRENCY = os.environ.get("SAP_TRANSACTION_CURRENCY", "USD")

# Live tests against a real SAP tenant are opt-in and off by default —
# see app/tests/test_sap_live.py. Never enabled automatically.
SAP_INTEGRATION_TESTS = os.environ.get("SAP_INTEGRATION_TESTS", "false").strip().lower() == "true"
SAP_TEST_CUSTOMER = os.environ.get("SAP_TEST_CUSTOMER")
SAP_TEST_MATERIAL = os.environ.get("SAP_TEST_MATERIAL")
SAP_TEST_QUANTITY = os.environ.get("SAP_TEST_QUANTITY")

# Production Planning Agent's real manufacturing-service integrations (see
# app/integrations/manufacturing_services.py) — same "${SERVICE}_URL, with a
# localhost fallback" convention every TS service already uses for calling
# each other (e.g. scheduling-service's MES_INTEGRATION_URL); this is that
# same convention's first use from the Python side.
ROUTING_SERVICE_URL = os.environ.get("ROUTING_SERVICE_URL", "http://localhost:4002")
MACHINE_SERVICE_URL = os.environ.get("MACHINE_SERVICE_URL", "http://localhost:4008")
OPERATOR_SERVICE_URL = os.environ.get("OPERATOR_SERVICE_URL", "http://localhost:4009")
ORDER_SERVICE_URL = os.environ.get("ORDER_SERVICE_URL", "http://localhost:4001")
SCHEDULING_SERVICE_URL = os.environ.get("SCHEDULING_SERVICE_URL", "http://localhost:4005")
INVENTORY_SERVICE_URL = os.environ.get("INVENTORY_SERVICE_URL", "http://localhost:4010")
# The real relocation (agreed with the user): production planning and its
# post-approval commit are no longer computed here — they're requested
# from APS Platform (web/), a genuinely separate application, which does
# the actual manufacturing-service orchestration and hands back the real
# result. Sales asks, Manufacturing plans — not Sales doing Manufacturing's
# job itself. See app/integrations/manufacturing_services.py.
APS_PLATFORM_URL = os.environ.get("APS_PLATFORM_URL", "http://localhost:3001")

# mock_erp.xlsx's product ids ("P025") and Postgres's product ids (cuids)
# are two independently-seeded, unrelated id spaces — there is no shared
# master data between the Python sales side and the TS manufacturing side
# (confirmed: neither system has ever referenced the other's ids). This
# maps by product NAME (stable across a database reseed, unlike a cuid)
# so the Production Planning Agent knows which real manufacturing-service
# product a mock-ERP product corresponds to. Only products actually seeded
# via scripts/seed-demo-master-data.ts are mapped; anything else honestly
# reports UNPLANNABLE (see graph.py's _plan_production_via_manufacturing_services)
# rather than guessing.
MANUFACTURING_PRODUCT_IDS = {
    "Cable Management Kit": os.environ.get(
        "MANUFACTURING_PRODUCT_ID_CABLE_MANAGEMENT_KIT", "cmttv7zis0000qwcadf6v37jh"
    ),
}
