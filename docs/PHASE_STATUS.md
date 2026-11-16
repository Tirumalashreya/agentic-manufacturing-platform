# Execution status (after Phase 2 pass 2)

Nothing is staged or committed. All changes are in the working tree on top of the pre-existing uncommitted audit work.

| Phase | Status | Evidence | Remaining |
|---|---|---|---|
| 0 Discovery & baseline | VERIFIED COMPLETE | `docs/BASELINE.md` | none |
| 1 CI foundation | PARTIALLY COMPLETE | workflow written, YAML valid, commands verified locally | **never run on GitHub; as written the Python job will not be green** (see below); no lint step |
| 2 DB authority & consistency | PARTIALLY COMPLETE | `docs/PHASE2_DATA_AUTHORITY.md`; test results below | see "Why Phase 2 is not complete" |
| 3–11 | NOT STARTED | | |

## Phase 2 — what is in the working tree

Schema / migrations (3, applied to the dev DB; all 37 migrations also applied cleanly to an empty throwaway database -> 62 tables, then dropped):
`20261030000000_add_document_sequence`, `20261031000000_add_document_number_allocation`, `20261031010000_add_purchase_order_idempotency_key`.

* **order-service:** `GET /deliveries|/invoices` (keyset, tenant-scoped) · `PATCH /invoices/:id/status` (atomic CAS) · `POST /sequences/:kind/next` (atomic, floored on the caller **and** on Postgres rows, per-key replay) · `POST /customers/find-or-create` (advisory-locked).
* **inventory-service:** `POST /purchase-orders` honours `Idempotency-Key` through a UNIQUE column.
* **orchestrator:** Postgres id authority for Delivery (`POSTGRES_ID_AUTHORITY`) and Invoice (`POSTGRES_INVOICE_ID_AUTHORITY`) — **both off by default and set nowhere** · crash recovery of an already-written row · idempotency key written in the same workbook save as the row (Delivery, Invoice, SalesOrder, PurchaseOrder, FinancialAdjustment create/resolve/post) · `mark_invoice_paid` locked and mirrored · reconciler + admin endpoints · locked `create_customer` (dedupes exact name) and `update_sales_order_status` · PO idempotency keys threaded from the graph · CORS origins configurable, wildcard refused.

## Phase 2 — test results (this session, measured)

| Suite | Result | vs Phase 0 baseline |
|---|---|---|
| order-service | 124 passed (8 more reruns: 124/124; one earlier full pass showed 2 failures, unexplained) | 99 → 124 (+25) |
| inventory-service | 15 passed | 12 → 15 (+3) |
| packages/domain | 20 passed | 20 |
| scheduling / mes / machine / maintenance / erp-integration / frontend | 35 / 16 / 4 / 2 / 6 / 47 passed | unchanged |
| `tsc --noEmit` | 0 errors in all 18 TS workspaces | unchanged |
| Architecture contract | pass (8 self-tests) | unchanged |
| **Full Python suite** (one process, 16m04s) | **598 passed, 9 failed, 2 skipped** | 543 / 11 / 2 → **+53 new tests, all passing** |

Python failures, classified against the Phase 0 baseline:

| # | Test | Class |
|---|---|---|
| 1 | `test_billing::…create_invoice_dual_writes_a_real_postgres_row` | baseline: needs a live order-service on :4001 (not running) |
| 2 | `test_credit::…existing_orders_from_real_customer` | baseline: demo-data dependent |
| 3 | `test_entry_router::…unrecognized_product_order…` | baseline: live Groq 400 |
| 4–7 | `test_production_planning_agent` ×4 | baseline: APS web app on :3000 not running |
| 8 | `test_understanding_routing::…reference_resolution…` | baseline: `CUSTOMER_NOT_FOUND` demo data |
| 9 | `test_trading::test_dispatch_trading_order_delivers_and_bills` | **not in baseline.** Live-LLM flake: `groq.BadRequestError 400 tool_use_failed` raised inside `billing_agent`. Passes when run alone. Not a data-path failure. |

8 of 9 are the documented baseline set; 1 is a new, intermittent live-LLM failure. No failure is attributable to Phase 2 code.

## Phase 2 — live verification (real order-service + Postgres, throwaway enterprise, cleaned up, workbook restored byte-identical)

* Delivery and Invoice ids minted by Postgres above rows already present (`DEL0070`→`DEL0071`, `INV0163`→`INV0164`), not from 1; nothing overwritten.
* A process that allocated an invoice number and died left exactly one number consumed; the retry in a new process received the same number.
* An invalid request created nothing; a replay returned the same id.

## Why Phase 2 is NOT complete

1. **Rows are still Excel-first for Delivery/Invoice/SalesOrder/Customer.** Postgres now owns the *numbers*, behind flags that are off. Making Postgres the first writer of the rows was not done.
2. **Reconciliation exists only for Delivery/Invoice.** No SalesOrder or Customer reconciler.
3. **24 Excel writers are still outside the workbook lock** (list in `PHASE2_DATA_AUTHORITY.md` §6). Only the ones on the five requested paths were fixed.
4. **Financial adjustments created through chat have no idempotency key** (no stable request id exists at that point).
5. **order-service `withIdempotency` can strand a claim at `statusCode=0`** after a hard crash (known, documented in code, not changed — it needs one transaction across every route).
6. **Excel saves are not crash-atomic.**
7. **One unexplained order-service flake** (2 failures once, names not captured, not reproduced in 8 reruns).

## Findings that need your attention

* **Secret exposure (mine):** while diagnosing, I ran a command that built `GROQ_API_KEY` by grepping `services/agent-orchestrator/.env`. That file has several `GROQ_API_KEY*` lines, so a connection error echoed the key values into this session's tool output. They are in the local transcript (`~/.claude/projects/…/71b23651-….jsonl`). If that transcript is shared or synced, rotate the Groq keys. `TESTING.md` now warns against that pattern.
* **CI as written will fail.** With a dummy `GROQ_API_KEY`, a full run failed **54** tests, not the 9 I deselected: most agent tests call live Groq. Phase 0 looked fine only because the real key was present locally. Options: (a) supply a repository secret (paid, rate-limited, occasionally flaky), (b) add a `live_llm` marker and run those on a schedule. Your call; I did not deselect them wholesale because that would hide regressions. The comment in `ci.yml` now says so.
* **A test can pass for the wrong reason.** `test_delivery::…dual_writes_a_real_postgres_row` passed in the full run with no order-service running, because three stale dev rows (`DEL0006`, `DEL0013`, `DEL0039`: qty 7, C001, DISPATCHED) match its assertions when the reset workbook re-issues one of those ids. Not changed (the dev rows must stay untouched).
* **169 dev rows:** all created 2026-10-11 by Delivery/Invoice dual-write test runs; no foreign keys into them; untouched (still 50 / 119). 27 other `test-*` enterprises from 2026-09-28 – 2026-10-11 also pre-exist; none from today.
