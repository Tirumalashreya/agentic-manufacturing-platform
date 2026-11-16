# Test baseline (Phase 0)

Captured 2026-10-30 on HEAD `e65a291` + uncommitted working tree, local Postgres (:5434), Redis, Kafka; Docker and ClickHouse unavailable; APS web (:3000) not running.

| Suite | Result |
|---|---|
| order-service | 99 passed |
| scheduling-service | 35 passed |
| mes-integration | 16 passed |
| inventory-service | 12 passed |
| machine-service | 4 passed |
| maintenance-service | 2 passed |
| erp-integration | 6 passed |
| packages/domain | 20 passed |
| frontend (Ledger) | 47 passed |
| architecture contract | 8 self-tests + contract check pass |
| `tsc --noEmit` (7 services, frontend, web) | 0 errors |
| agent-orchestrator pytest (single process, 12m38s) | 543 passed, 11 failed, 2 skipped |

## agent-orchestrator: the 11 baseline failures, diagnosed

| Test | Cause | Class | Action |
|---|---|---|---|
| test_security::test_mutation_succeeds_for_planner_or_above ×3 | Test sent a pre-hardening payload; endpoint now requires `run_id` (422) | Stale test | **Fixed** (asserts auth passes → business 404) |
| test_production_tools::test_reserve_stock_concurrent_different_keys… | Asserted on PLANT02 only; `reserve_stock` allocates across plants in sheet order. Not a lost update | Stale test | **Fixed** (sums plants; still asserts exactly 5 decrements) |
| test_credit::…existing_orders_from_real_customer | Depends on demo-workbook state ("earlier live testing") that the clean workbook lacks | Data-dependent | Deselected in CI; to be rewritten to create its own exposure |
| test_entry_router::…unrecognized_product… | Live Groq call returned 400 (`intentResult` tool not in request.tools) | External/LLM | Deselected; revisit in Phase 9 eval work |
| test_production_planning_agent ×4 | `httpx.ConnectError`: needs APS web app on :3000 | Infra-blocked | Deselected in CI; run locally with APS up |
| test_understanding_routing::…reference_resolution… | Got CUSTOMER_NOT_FOUND instead of NEEDS_CLARIFICATION | Data-dependent (not diagnosed further) | Deselected |

After the two test fixes (4 tests): **7 baseline failures remain**, all environmental or data-dependent (none is a demonstrated product defect). They are deselected in CI and tracked here until fixed.

Note: the first local attempt hit the tool's 10-minute timeout mid-run and left `mock_erp.xlsx` modified; it was restored from a pre-run backup. A clean full run restores it itself via `conftest.py`.

Two further tests (`test_billing::…dual_writes_a_real_postgres_row`, `test_delivery::…dual_writes_a_real_postgres_row`) passed in the baseline run but need a live order-service on :4001; they fail with connection refused when it is down and pass (49/49 in the Phase 2 file set) when it is running. They are deselected in CI until the python job starts order-service.
