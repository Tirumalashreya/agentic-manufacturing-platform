# SAP Integration (Phase 5)

## Architecture

```text
Agent / Workflow (graph.py, agents/*)
        ↓
ERPAdapter interface (app/erp/interface.py) — unchanged, pre-existing
        ↓
app/erp/factory.py  — reads ERP_BACKEND, returns the right implementation
        ↓
┌───────────────────────┐   ┌──────────────────────────┐
│ MockERPAdapter          │   │ SAPAdapter                 │
│ (app/erp/mock_erp_...)  │   │ (app/erp/sap/adapter.py)  │
│ → openpyxl / mock_erp.xlsx │   │ → SAP OData V2 (A2X)     │
└───────────────────────┘   └──────────────────────────┘
```

`graph.py` and `context_agent.py` import `default_erp_adapter` from
`app.erp.factory` — that is the *only* change Phase 5 makes to the agent
layer. Neither file knows or cares whether it's talking to Excel or SAP.

## Enabling SAP

```bash
ERP_BACKEND=sap
SAP_BASE_URL=https://your-tenant.s4hana.ondemand.com/sap/opu/odata/sap/API_SALES_ORDER_SRV
SAP_USERNAME=...
SAP_PASSWORD=...

# Tenant-specific sales-area config — required, never guessed:
SAP_SALES_ORGANIZATION=1710
SAP_DISTRIBUTION_CHANNEL=10
SAP_ORGANIZATION_DIVISION=00
SAP_SALES_ORDER_TYPE=OR
SAP_TRANSACTION_CURRENCY=USD   # optional, defaults to USD

# Optional:
SAP_TIMEOUT_SECONDS=30         # default 30
SAP_DRY_RUN=true               # build+validate the payload, never send it
```

Leaving `ERP_BACKEND` unset (or `mock`) behaves exactly as before Phase
5 — every existing test and workflow runs against the mock ERP with zero
SAP configuration required.

## Scope: what's real vs. not implemented

Only **`create_sales_order`** has real logic, mapped against the actual
SAP Sales Order (A2X, OData V2) API this session researched from real
SAP documentation (`POST /A_SalesOrder`, with `to_Item`).

Every other `ERPAdapter` method on `SAPAdapter`
(`get_customer`, `get_product`, `get_stock`, `check_credit`,
`reserve_stock`, `create_production_order`, `create_purchase_order`,
`create_delivery`, `create_invoice`, `mark_invoice_paid`, etc.) raises
`NotImplementedError` with a message naming the method. This is
deliberate, not an oversight: each of those needs its own real SAP API
(Business Partner, Product Master, ATP, Credit Management — none of
which were researched from actual SAP documentation this session), and
fabricating plausible-looking field mappings for APIs nobody has
verified would violate the one rule this integration can't compromise
on: **never guess tenant-specific data or fields.**

Practical consequence: the demonstrated "check credit, then place the
order" composed flow (`app/tools/plan_executor.py`) will work end-to-end
against `ERP_BACKEND=mock`, but against `ERP_BACKEND=sap` the
`check_credit` step will raise `NotImplementedError` until a real Credit
Management API integration is built. That's an honest current
limitation, not a bug.

## The master-data problem (real, unsolved, and expected)

This system's own customer/product IDs (`C001`, `P011`, ...) are mock
catalog IDs. A real SAP tenant's `SoldToParty`/`Material` values are
different, tenant-specific numbers. `create_sales_order` will send
whatever `customer_id`/`product_id` it's given straight through as
`SoldToParty`/`Material` — there is no mapping table between "our
customer" and "SAP's Business Partner" yet, because building one
requires inspecting a real tenant's actual master data (Phase 5C/5D in
the agreed roadmap), which needs real SAP access this session doesn't
have.

## Error handling

Every failure surfaces as one of the `ERPError` subclasses in
`app/erp/sap/errors.py` — `ERPAuthenticationError` (401),
`ERPAuthorizationError` (403), `ERPValidationError` (400 or a locally-
caught bad payload before any HTTP call), `ERPNotFoundError` (404),
`ERPConflictError` (409), `ERPRateLimitError` (429),
`ERPUnavailableError` (5xx, unreachable, or unparsable response),
`ERPTimeoutError` (request timed out — **the real SAP-side outcome is
unknown**, since SAP may have committed the order before the response
was lost; this is never automatically retried).

`ERPNotConfiguredError` is distinct from all of these — it means SAP
credentials/URL aren't set at all, raised from `SAPAdapter.__init__`,
never from a real SAP call.

`SAPAdapter` never fabricates a success. If SAP isn't configured,
`get_erp_adapter()` raises before any request is even attempted.

## Dry run

`SAP_DRY_RUN=true` builds and validates the real payload (using real
tenant sales-area config) and returns it in the response's `reason`
field, but never sends the request. Use this to verify mapping/config
correctness before ever touching a real tenant.

## Health check

```bash
python -m app.erp.sap.healthcheck
```

Performs a safe CSRF-token fetch (a GET request) to confirm connectivity
and authentication — creates no business document.

## Testing

- `test_sap_client.py`, `test_sap_mapper.py`, `test_sap_adapter.py`,
  `test_erp_factory.py` — fully deterministic, zero network, zero
  credentials. SAP responses are faked via `httpx.MockTransport`.
- `test_sap_live.py` — real tests against a real tenant. Skipped by
  default; requires `SAP_INTEGRATION_TESTS=true` plus
  `SAP_TEST_CUSTOMER`/`SAP_TEST_MATERIAL`/`SAP_TEST_QUANTITY`. Never
  runs as part of a normal `pytest` invocation.

## Idempotency / retries

Not implemented, and deliberately not faked. A timeout on
`create_sales_order` means SAP's real-world outcome is genuinely
unknown — this adapter does not automatically retry, and callers must
not either without a real duplicate-prevention strategy (SAP does not
document a general idempotency-key mechanism for this API in what this
session reviewed). Automatically retrying a timed-out create risks a
duplicate real sales order.

## Next steps (not built this session)

1. **Real SAP tenant access** — a test S/4HANA Cloud environment,
   communication arrangement for the Sales Order API, and real test
   customer/material IDs. Nothing beyond `test_sap_live.py`'s skip-gated
   scaffolding can proceed without this.
2. **Master-data mapping** — a real Customer↔SoldToParty and
   Product↔Material table, buildable only once a real tenant's actual
   master data can be inspected.
3. **`get_customer`/`get_product`/`get_stock`/`check_credit` on
   `SAPAdapter`** — each needs its own real SAP API research (Business
   Partner API, Product Master API, ATP, Credit Management) before
   being implemented honestly.
4. **Sales Order Simulation** (`API_SALES_ORDER_SIMULATION_SRV`) — a
   real, documented SAP capability for pricing/ATP/credit checks without
   committing an order. Worth building once the above are real, since it
   maps naturally onto this system's existing `check_credit`/
   `check_stock` composed-action pattern.
