# Phase 2 — Data authority and consistency (as implemented)

This document describes what the code does today, not a target. Evidence for each claim is a named test (see the end).

## 1. Authoritative persistence model

"Authoritative" means: when the two stores disagree, which one is the record, and what repairs the other.

| Entity | Authoritative store today | Other copy | Write order | Transaction boundary | Duplicate protection | Reconciliation / repair |
|---|---|---|---|---|---|---|
| Delivery | Excel `Deliveries` (flag off) · Postgres id authority for the *id* (flag on), Excel still holds the legacy row | Postgres `Delivery` (mirror, upsert on `(enterpriseId, externalDeliveryId)`) | id (PG, flag on) → Excel append + idempotency key in **one save** → PG upsert | none across stores; Excel save is one atomic-ish file write | Excel workbook lock + idempotency key; PG unique `(enterpriseId, externalDeliveryId)`; sequence + per-key allocation table | `GET/POST /reconciliation/post-sales[/repair]` (ADMIN) |
| Invoice | same as Delivery, own flag | Postgres `Invoice` | same | same | same; `PATCH …/status` is an atomic CAS ISSUED→PAID | same reconciler; PAID is never regressed |
| SalesOrder | Excel `SalesOrders` (the SO id + status the channels read) | Postgres `SalesOrder`+`OrderLine`+`FulfillmentPlan`+`FulfillmentLine` | Excel (locked, key+row one save) → PG in **one transaction** | PG: one `$transaction` (rolled back as a unit) | PG unique `(enterpriseId, externalOrderId)` and `(enterpriseId, orderNumber)`; `Idempotency-Key` claim; Excel lock + key | **No reconciler for SalesOrder** (open) |
| Customer | Excel `Customer Master` (credit limit, active flag) | Postgres `Customer` (fulfillment relations) | Excel create (locked, exact-name dedupe) → PG `find-or-create` | PG: advisory-lock transaction per `(enterprise, name)` | No unique on `Customer.name` by design (see §3) | none (open) |
| PurchaseOrder (Excel flow) | Excel `PurchaseOrders` (`PUR####`) | none | locked, key+row one save | n/a | Excel lock + idempotency key (graph now passes `po-<prodOrder>-<component>-<vendor>`) | n/a |
| PurchaseOrder (inventory flow) | Postgres `PurchaseOrder` | none | PG insert | single insert | **UNIQUE `idempotencyKey`** (new); same key + different body = 409 | n/a |
| FinancialAdjustment | Excel `FinancialAdjustments` | none (no PG model) | locked, key+row one save, audit event after | n/a | Excel lock + key; resolve/post are status-guarded under the lock | n/a |

The PostgreSQL id-authority work does **not** make Postgres the owner of the Delivery/Invoice *rows* — it makes Postgres the owner of the *numbers*. Excel remains the legacy row store; making PG the first writer of the row is a separate step and was not done.

## 2. Id authority (both flags OFF by default)

* `POSTGRES_ID_AUTHORITY=1` → Delivery ids. `POSTGRES_INVOICE_ID_AUTHORITY=1` → Invoice ids. Independent flags; neither enabled anywhere in this repo, CI, or `.env`.
* Format unchanged: `DEL0001`, `INV0001`.
* `POST /sequences/:kind/next` (order-service): one atomic upsert-increment. The value is `max(sequence, callerFloor, highest matching id already in Postgres) + 1`. The Postgres-row floor matters: dev Postgres holds `DEL0070`/`INV0163` while the clean workbook holds none, and the mirror upserts by external id — without it, enabling the flag would hand out `DEL0001` and silently overwrite an existing row.
* `idempotencyKey` → `DocumentNumberAllocation` (unique per enterprise+kind+key, advisory-locked): a retry of the same logical request gets the **same number**, including after the process that first allocated it died.
* Orchestrator order of operations: validate → read cache/Excel max under a shared lock → allocate (network, **outside** the workbook lock) → exclusive lock: re-check cache, refuse if the id already exists for a different request, write row + key in one save.
* Fail-closed: Postgres unreachable → `{"created": False, "reason": "Postgres id authority unavailable: …"}`; no Excel-minted fallback id (would let the two id spaces collide).
* Crash recovery: if the id's row is already in Excel and matches this request (same order/product/quantity [/ delivery/unit price]), it is reported as the created record and its idempotency key is re-recorded — no second row, no overwrite. A different request on the same id is refused.
* Idempotency state lives in the workbook's `IdempotencyKeys` sheet (a file), **not** in process memory, so a restart does not lose it. It is also now written in the same `save()` as the business row for Delivery, Invoice, SalesOrder, PurchaseOrder and FinancialAdjustment (create, resolve, post), removing the window where a crash between two saves let a same-key retry duplicate the record.
* Gaps in the sequence are expected (a request that allocates and then fails burns a number).

## 3. Decisions and their reasons

* **Customer: no unique constraint on `(enterpriseId, name)`.** Names are not unique in general (ERP customers are keyed by `externalCustomerId`; two real companies can share a name), so a constraint could reject legitimate data. Instead `POST /customers/find-or-create` serialises on a transaction-scoped advisory lock per `(enterprise, name)`. Existing dev data had 0 duplicate names.
* **Excel `create_customer` is now locked and de-duplicates on exact case-insensitive name.** `context_agent` did `get_customer` → `create_customer` with nothing between them.
* **`update_sales_order_status` is now locked.** It rewrote the whole workbook unguarded and could drop a concurrent locked create's row.
* **No generic lock was added to every writer.** 24 other workbook writers remain outside the lock (list in §6).
* **SalesOrder Postgres creation needed no code change.** The existing unique constraints plus the transaction already give: 20 concurrent same-key requests → one order; 20 different keys with one `externalOrderId` → one order and 19 clean 409s with no orphan `OrderLine`. Tests were added to pin this.

## 4. Development data (169 rows) — inspected, untouched

Read-only inspection of dev Postgres, enterprise `seed-enterprise` ("Demo Manufacturing Co") only:

| | Delivery | Invoice |
|---|---|---|
| Rows | 50 | 119 |
| Created | 2026-10-11 05:29–06:01 | 2026-10-11 05:29–11:39 |
| Ids | `DEL0001`–`DEL0070` (50 distinct) | `INV0001`–`INV0163` (119 distinct) |
| Status | all `DISPATCHED` | all `ISSUED` |
| No `externalSalesOrderId` | 15 | 76 |
| Test-pattern SO ids (`SO-TEST-*`, `SO-CONC-*`, `SO-SEQ-1`, `SO-MISMATCH-1`) | 12 | ~26 |
| FK to a real `SalesOrder` | 20 (`SO00xx`, orders created by agent-orchestrator 2026-10-05) | 14 |
| Other tables referencing them (FKs) | none | none |

Likely origin: the Delivery/Invoice dual-write tests run on 2026-10-11 (the day the feature and its migration were built) while order-service was up. Those tests write to the real order-service but `conftest.py` resets only the workbook, so rows accumulate in Postgres and ids restart from `0001` each run (hence the gaps and the restart of numbering). Nothing has been written since that date — consistent with order-service not running during later test runs. This pollution mechanism still exists whenever order-service is up during pytest. Nothing was deleted or modified.

## 5. CORS and browser access

* No browser code calls any backend service directly. Ledger's browser code calls only its own `/api/orchestrator` proxy; the proxy and all of both Next apps' backend URLs are server-side env vars (none `NEXT_PUBLIC_*` except the APS link). So CORS is **not required** by any current browser path.
* agent-orchestrator keeps CORS as defence in depth. Origins now come from `CORS_ALLOWED_ORIGINS` (comma-separated exact origins); unset keeps the previous default `http://localhost:3000`; empty allows none; a wildcard or non-origin makes startup fail. The unhandled-error response now echoes the request `Origin` only when it is on the allow-list (it used to hard-code the constant).
* Node services: no CORS middleware, which is correct — they are not browser-facing. Do not add any.
* Recommended production setting: `CORS_ALLOWED_ORIGINS=` (empty). Broader security work (rate limiting, headers, service-token comparison) is Phase 10.

## 6. Open risks and not done

1. **Row authority is still Excel for Delivery/Invoice/SalesOrder/Customer.** Only the numbers can come from Postgres. Full inversion (PG first, Excel as mirror) is not done.
2. **No SalesOrder or Customer reconciler** (only Delivery/Invoice).
3. **24 Excel writers are not under the workbook lock**, so each can still drop a concurrent locked writer's row via whole-workbook rewrite: `approval_tools` (create/resolve), `consignment_tools` (create, `_set_fields`), `export_tools.create_export_order`, `idempotency_tools.record_idempotent_result`, `post_sales_tools.resolve_return_inspection`, `pricing_tools._discount_policy_sheet`, `production_tools.create_production_order`, `project_tools` (5), `sales_tools.create_quotation`, `service_tools` (3), `subscription_tools` (3), `trading_tools` (3). Not individually verified as racy; some are called from locked callers (the lock is reentrant).
4. **Excel saves are not crash-atomic** (openpyxl writes the file in place; a crash mid-write can corrupt the workbook). Fix would be write-temp-then-rename in one helper.
5. **Financial adjustments created through the chat flow carry no idempotency key** (`financial_node` has no stable request id; hashing the content would also dedupe a legitimate repeat). Mitigated only by the ≥ 50,000 approval gate.
6. **order-service `withIdempotency` can leave a claim at `statusCode=0` forever** after a hard crash between the business commit and the claim update (documented in the code, deliberately not changed: it needs the claim and business write in one transaction across every route).
7. **Allocation rows grow unbounded** (tiny; no retention job).
8. **Intermittent order-service test failure, unexplained:** one full TS pass showed `2 failed | 122 passed (124)` in order-service while the Python suite was running; the failing test names were not captured. 8 further runs (5 idle, 3 under the same Python load) were 124/124. Treat as a possible flake until reproduced.
9. The 169 dev rows will appear as `missing_in_excel` in every reconciliation report.

## 7. Where the behaviour is tested

* order-service (real Postgres): sequence atomicity/floor/per-tenant/per-key/Postgres-row floor/validation; 50 and 20-way concurrency; SalesOrder duplicate and mismatch cases; `find-or-create` concurrency and tenancy; PAID CAS.
* inventory-service (real Postgres): PO idempotency, 20-way concurrency, mismatch 409.
* orchestrator (`test_postgres_id_authority.py`, `test_phase2_creation_paths.py`, `test_post_sales_reconciliation.py`, `test_cors_policy.py`): flag off/on for both ids, fail-closed, replay, invalid input allocates nothing, Excel conflict refused, concurrent distinct ids, allocation then Excel failure then retry, crash-after-row recovery, restart in a separate process, single-save atomicity, customer/SO/PO/adjustment concurrency.
* Live (real order-service + Postgres, throwaway enterprise, cleaned up): Delivery and Invoice ids minted by Postgres above seeded `DEL0070`/`INV0163` (`DEL0071`, `INV0164`); a process that allocated and died left exactly one number consumed and the retry received it.
