# Architecture Baseline

Stage 00 — factual ground truth only. No source files were modified to produce this document. Every claim below is labeled **VERIFIED** (directly observed in code/output this session), **PARTIAL** (observed for some but not all cases), or **UNKNOWN** (could not be established from static inspection). Documentation (PLAN.md, SESSION_SUMMARY.md, README.md, and in-code comments) is treated as a claim, not a fact, unless independently confirmed against code or a live run.

---

## 1. Repository State

**Commands executed:**
```
git log --oneline -12
git status
ls services
```

**`git log --oneline -12`** (repo has 9 commits total, fewer than 12 requested):
```
f27949e Merge remote history: this commit's tree is the authoritative, current state (local work supersedes the prior snapshot)
4f1f1ab Order-to-production fulfillment architecture + concurrency hardening
dd2ca96 Build out full agentic sales workflow suite + demo frontend
3be06c7 Untrack runtime logs and compiled bytecode now covered by .gitignore
41ff0fb Merge remote history: retain local evolved services/agent-orchestrator work over the earlier snapshot
87784dc Build out full agentic Direct Sales pipeline through Trading/Service/Subscription lifecycles
a7cedbc Sales pipeline: Intent + Context agents wired into graph, mock ERP data, tools/schemas structure
4defec1 Sales/O2C agentic pipeline: Python agent-orchestrator scaffold, Postgres logging tables, final architecture in PLAN.md
0e6039f Initial copy — agentic manufacturing platform experiment
```

**`git status`** (VERIFIED — captured verbatim): on branch `main`, up to date with `origin/main`. **Working tree is dirty** — these are pre-existing, uncommitted changes from work done earlier in this session (a `FulfillmentLine.reason` feature), not anything touched by this baseline pass:
```
modified:   frontend/src/app/domestic-sales/[salesOrderId]/page.tsx
modified:   packages/domain/prisma/schema.prisma
modified:   packages/domain/src/generated/prisma/internal/class.ts
modified:   packages/domain/src/generated/prisma/internal/prismaNamespace.ts
modified:   packages/domain/src/generated/prisma/internal/prismaNamespaceBrowser.ts
modified:   packages/domain/src/generated/prisma/models/FulfillmentLine.ts
modified:   services/agent-orchestrator/app/graph.py
modified:   services/agent-orchestrator/app/integrations/order_domain.py
modified:   services/agent-orchestrator/app/routers/sales_orders.py
modified:   services/agent-orchestrator/app/tests/test_order_domain_dual_write.py
modified:   services/agent-orchestrator/mock_erp.xlsx
modified:   services/order-service/src/app.test.ts
modified:   services/order-service/src/app.ts
modified:   web/src/app/(app)/dashboard/page.tsx
modified:   web/src/app/(app)/orders/[id]/page.tsx
Untracked: packages/domain/prisma/migrations/20261005084738_fulfillment_line_reason/
```
No files were added, removed, or changed by this Stage 00 pass beyond creating this one new file.

**`ls services`** — 18 services (VERIFIED):
```
agent-orchestrator  analytics-service  calendar-service   erp-integration
inventory-service   iot-ingestion      machine-service    maintenance-service
mes-integration      notification-service  operator-service  optimization-service
optimization-solver  order-service     reporting-service  routing-service
scheduling-service   tool-service
```

**Repository structure:** npm workspaces monorepo (`web`, `frontend`, `packages/*`, `services/*`). 16 of the 18 services are plain-Node/Express/TypeScript (`tsx` dev runtime, no compile step observed), using `packages/shared` (logger, Kafka client, service-auth middleware) and `packages/domain` (one shared Prisma schema/client). `agent-orchestrator` and `optimization-solver` are Python/FastAPI.

**Root `package.json` scripts:** only `db:migrate` and `db:generate` — **no root dev/start/test orchestration script, no docker-compose, no Procfile exists anywhere in the repo root** (VERIFIED — `find . -maxdepth 1 -iname "docker-compose*" -o -iname "Procfile"` returned nothing). Every service is started manually.

**Read also:** `packages/domain/prisma/schema.prisma`, `packages/shared/src/topics.ts`, `packages/shared/src/serviceAuth.ts`, `PLAN.md`, `SESSION_SUMMARY.md`, `README.md` — full content inspected; findings folded into the relevant sections below.

---

## 2. Service Map

Reads/writes are **model-level, from static `prisma.<model>.*` / transaction-client `tx.<model>.*` call-site greps over each service's non-test source files** (VERIFIED by direct grep, not inferred). Relational reads reached only via Prisma `include` on a nested relation are not separately counted. Outbound calls and pub/sub are from direct grep of `fetch(`/axios/`publish(`/`subscribe(` call sites.

| Service | Entry point | Port (default) | Reads (models) | Writes (models) | Publishes | Consumes |
|---|---|---|---|---|---|---|
| agent-orchestrator | `app/main.py` (FastAPI) | **UNKNOWN** — no port bound in code or Dockerfile; run as `uvicorn app.main:app --port 8000` by convention only (confirmed working at :8000 this session, but not declared anywhere in the repo) | mock_erp.xlsx (customers/products/sales orders/etc., all sheets); Postgres via HTTP to order-service/other TS services, no direct Prisma client | mock_erp.xlsx; Postgres indirectly via HTTP (order-service's SalesOrder/OrderLine/FulfillmentPlan/FulfillmentLine); `AgentPipelineRun`/`AgentStageResult` via `app/db.py` (asyncpg, direct SQL) | none (no Kafka client in this service) | none |
| optimization-solver | `main.py` (FastAPI + OR-Tools CP-SAT) | 4007 (Dockerfile `EXPOSE`/`CMD`) | none (stateless solver, request body only) | none | none | none | — **Dockerfile explicitly states "not built/run in this environment (no Docker installed locally)"** (VERIFIED, read verbatim from the file) |
| order-service | `src/index.ts` | 4001 | `customer`, `productionOrder`, `salesOrder`, `scheduledOperation`, `fulfillmentLine`, `orderLine` (via tx) | `customer`, `productionOrder`, `productionOrderDependency`, `resourceReservation`, `salesOrder`, `scheduledOperation`, `fulfillmentLine`, `fulfillmentPlan`, `orderLine` (all via `tx.*` inside `$transaction`, with `SELECT…FOR UPDATE`) | `ORDERS_PRODUCTION_CREATED`, `ORDERS_PRODUCTION_UPDATED` | none |
| scheduling-service | `src/index.ts` (+ `pipeline.ts`, `cpm.ts`) | 4005 | `bOM`, `factoryCalendar`, `inventory`, `machine`, `machineEvent`, `maintenanceOrder`, `operator`, `productionException`, `productionOrder`, `productionOrderDependency`, `purchaseOrder`, `qualityInspection`, `resourceReservation`, `routingOpDependency`, `schedule`, `scheduleAuditLog`, `scheduledOperation`, `workCenter` | `productionException`, `productionOrder`, `qualityInspection`, `resourceReservation`, `schedule`, `scheduleAuditLog`, `scheduleRun`, `scheduledOperation` (+ `tx.resourceReservation`, `tx.scheduledOperation`) | `SCHEDULE_PUBLISHED`, `OPERATIONS_EXCEPTION_REPORTED`, `QUALITY_INSPECTION_RECORDED` | `ORDERS_PRODUCTION_UPDATED`, `MACHINES_BREAKDOWN_REPORTED`, `MACHINES_STATUS_CHANGED`, `MAINTENANCE_ORDERS_CREATED` |
| optimization-service | `src/index.ts` (+ `load-balancing.ts`, `tsp.ts`) | 4006 | `scheduledOperation`, `workCenter` | `resourceReservation`, `scheduledOperation` | none | none — calls optimization-solver (4007) by HTTP |
| inventory-service | `src/index.ts` | 4010 | `bOM`, `inventory`, `inventoryMovement`, `product`, `productionOrder`, `purchaseOrder`, `vendor`, `vendorProduct` | `inventory`, `inventoryMovement`, `purchaseOrder`, `vendor`, `vendorProduct` | `INVENTORY_SHORTAGE_DETECTED`, `INVENTORY_MOVEMENT_RECORDED` | `ORDERS_PRODUCTION_CREATED` |
| machine-service | `src/index.ts` | 4008 | `machine`, `workCenter` | `machine`, `machineCapability`, `machineEvent`, `sensorReading`, `workCenter` | `MACHINES_STATUS_CHANGED`, `MACHINES_BREAKDOWN_REPORTED` | `MACHINES_SENSORS` |
| operator-service | `src/index.ts` | 4009 | `operator`, `skill` | `operator`, `operatorShift`, `operatorSkill`, `resourceReservation`, `scheduledOperation`, `skill` | none | none |
| tool-service | `src/index.ts` | 4011 | `tool` | `tool`, `toolUsage` | none | none |
| maintenance-service | `src/index.ts` | 4012 | `maintenanceOrder` | `maintenanceOrder`, `maintenancePlan` | `MAINTENANCE_ORDERS_CREATED` | none |
| calendar-service | `src/index.ts` | 4013 | `factoryCalendarDay`, `holidayCalendar`, `shift` | `factoryCalendar`, `factoryCalendarDay`, `holiday`, `holidayCalendar`, `shift` | none | none |
| notification-service | `src/index.ts` | 4014 | none (no Prisma use) | none | none | `MACHINES_BREAKDOWN_REPORTED`, `INVENTORY_SHORTAGE_DETECTED`, `MAINTENANCE_ORDERS_CREATED` (→ email via Resend, if configured), and separately `ORDERS_PRODUCTION_CREATED`, `ORDERS_PRODUCTION_UPDATED`, `SCHEDULE_PUBLISHED` (→ SSE relay to connected dashboards) |
| reporting-service | `src/index.ts` | 4016 | `productionOrder`, `schedule`, `scheduleAuditLog`, `scheduleRun`, `scheduledOperation` | none | none | none |
| analytics-service | `src/index.ts` | 4017 | none (no Prisma use found) — **UNKNOWN what its real data source is without reading its full route bodies, not done this pass** | none | none | none |
| erp-integration | `src/index.ts` | 4018 | none | `customer`, `salesOrder` (one-way mock-SAP IDoc bridge, matches PLAN.md's description) | none | none |
| mes-integration | `src/index.ts` | 4019 | `bOM`, `inventory`, `plant`, `productionException`, `scheduledOperation` | `inventory`, `inventoryMovement`, `productionOrder`, `scheduledOperation` | `INVENTORY_MOVEMENT_RECORDED` | `SCHEDULE_PUBLISHED` |
| iot-ingestion | `src/index.ts` | 4020 | none (no Prisma use) | none | `MACHINES_SENSORS` | none |
| routing-service | `src/index.ts` | 4002 (default-port grep; not independently started/verified live this pass) | `bOM`, `routing` | `bOM`, `bOMLine`, `product`, `routing`, `routingOpDependency`, `routingOperation` | none | none |

Two services (web's own Next.js server, frontend's own Next.js server) are not under `services/` but are real runtime participants — see §9 for the port-contradiction finding.

**Methodology caveat (PARTIAL):** this table is model-level static analysis, not a full endpoint-by-endpoint read of every route body. Outbound HTTP call targets (which service calls which) were not separately tabulated for every service beyond what Kafka/DB evidence already implies; a full "every outbound HTTP/service call" map (as literally requested) would need a second pass grepping every `fetch(`/`http://localhost:` literal per service.

---

## 3. Test Baseline

**No root-level test command exists.**
```
$ npm test
npm error Missing script: "test"
```
(VERIFIED — root `package.json` has no `"test"` script at all.)

### order-service
```
$ npx vitest run src/app.test.ts
(DATABASE_URL, INTERNAL_SERVICE_TOKEN set)

 Test Files  1 passed (1)
      Tests  39 passed (39)
```
Exit code 0 (VERIFIED — clean pass, no failures printed).

### scheduling-service
```
$ npx vitest run
(DATABASE_URL, INTERNAL_SERVICE_TOKEN set)

 Test Files  2 passed (2)
      Tests  11 passed (11)
```
Exit code 0 (VERIFIED). Two test files: `pipeline.affected-scope.test.ts`, `pipeline.extended-horizon.test.ts`.

### agent-orchestrator
```
$ python3 -m pytest app/tests/ -q
(run earlier in this same session, same working tree)

17 failed, 414 passed, 2 skipped, 1 warning in 552.45s (0:09:12)
```
Exit code: **PARTIAL** — not independently re-captured via `echo $?` in this pass (would require a second 9-minute run); inferred as 1 per standard pytest semantics (non-zero on any failure), not directly observed this session.

The 17 failures, by file:
```
test_credit.py::test_check_credit_includes_existing_orders_from_real_customer
test_credit_check_live.py::test_order_within_credit_limit_proceeds_to_fulfillment
test_credit_check_live.py::test_order_over_credit_limit_is_held
test_entry_router.py::test_create_order_routes_to_direct_sales
test_entry_router.py::test_create_order_for_unregistered_customer_lands_on_credit_hold
test_entry_router.py::test_unrecognized_product_order_asks_for_clarification_not_financial
test_fulfillment_execution.py::test_full_stock_order_is_fulfilled_from_stock
test_fulfillment_execution.py::test_configurable_product_order_requires_configuration
test_fulfillment_execution.py::test_no_stock_third_party_is_sourced_from_vendor
test_production_planning_agent.py::test_plan_production_pass_when_materials_and_schedule_are_clean
test_production_planning_agent.py::test_plan_production_forces_material_shortage_even_if_agent_says_pass
test_production_planning_agent.py::test_plan_production_unplannable_when_product_not_mapped
test_production_planning_agent.py::test_composed_execution_mto_plans_production_before_approval
test_security.py::test_mutation_succeeds_for_planner_or_above[PLANNER]
test_security.py::test_mutation_succeeds_for_planner_or_above[ADMIN]
test_security.py::test_mutation_succeeds_for_planner_or_above[OWNER]
test_understanding_routing.py::test_reference_resolution_runs_between_understanding_and_context
```
One concrete assertion failure captured verbatim (`test_understanding_routing.py`):
```
AssertionError: assert 'CUSTOMER_NOT_FOUND' == 'NEEDS_CLARIFICATION'
```
**Not investigated further — root cause of these 17 not diagnosed this pass** (explicitly out of scope: "DO NOT FIX FAILURES"). These failures existed before this Stage 00 session touched anything.

### Coverage gap (VERIFIED)
Of 18 services, only **3 have any automated test file at all**: `order-service`, `scheduling-service`, `agent-orchestrator`. The other 15 (`analytics-service`, `calendar-service`, `erp-integration`, `inventory-service`, `iot-ingestion`, `machine-service`, `maintenance-service`, `mes-integration`, `notification-service`, `operator-service`, `optimization-service`, `optimization-solver`, `reporting-service`, `routing-service`, `tool-service`) have zero test files (`find services -name "*.test.ts" -o -iname "test_*.py"`, excluding node_modules/.venv — confirmed empty for all 15).

---

## 4. LLM Inventory

**Single provider, single model, confirmed:** `GROQ_MODEL = "openai/gpt-oss-120b"` (`app/config.py:6`) via Groq's hosted API, accessed through `langchain_groq.ChatGroq`. The `"openai/"` prefix is Groq's own model-catalog naming, not a real OpenAI API call — grepping the whole repo for `openai`/`anthropic`/`Gemini`/`google.generativeai` outside this one string found nothing else (VERIFIED). 21 files under `app/agents/` import `ChatGroq`.

Deep-traced (read full file + call site + consumption):

| File | Node/function | Input | Output used as | Consumes into a write? | Classification |
|---|---|---|---|---|---|
| `intent_agent.py` | `intent_agent` | raw user message | `intent`, extracted entities | No — routes to next agent only | A. Understanding/extraction |
| `context_agent.py::resolve_product_name` | fuzzy product-name match | raw text + real catalog list | product name, **only accepted if it's an exact, real catalog entry** (`graph.py`-adjacent guard at `context_agent.py:33`: `if result.matched_product_name in catalog`) | Indirectly (resolved product feeds order creation) but **hallucination-proof by construction** | A, SAFE (verified guard) |
| `process_agent.py` | `process_node` → `entry_router` | intent + customer/product context + `resolved_references` | `entry_type` drives `entry_router`'s dispatch (`graph.py:981-999`) to one of 9 workflow branches | **Yes, indirectly** — determines which workflow (and therefore which write path) runs | D, **PARTIALLY GUARDED** — one narrow deterministic override exists (`graph.py:982-987`, a documented historic misclassification bug: FINANCIAL forced back to `unclear` when the request plainly mentions a product/service and no financial language) but every other `entry_type` value is dispatched on as-is |
| `request_understanding_agent.py` | parallel extraction | raw message | `mentions_product_or_service`, `mentions_financial_adjustment`, references | Only consumed by the one override above, and by reference resolution | A |
| `quotation_agent.py` | pre-sales quoting | catalog price, stock, lead time | `quoted_price` — prompt explicitly forbids inventing a discount; `None` if `catalog_price` missing | No direct order/stock write (pre-sales only) | C, constrained by prompt (not independently verified against a deterministic override — **PARTIAL**) |
| **`fulfillment_agent.py`** | `fulfillment_decision_node` | `product_name, quantity, stock_total, can_produce, product_configurable, lead_time_days` | **`decision.strategy` (MTS/MTO/CTO/HYBRID/THIRD_PARTY/INTERCOMPANY) flows directly, unvalidated, into `state["fulfillment_strategy"]`** (`graph.py:1616-1627`), which `fulfillment_router` (`graph.py:1641-1655`) dispatches on to decide: reserve stock, create a `ProductionOrder`, or source from a vendor | **YES, directly and unguarded** | **E — a real business decision (fulfillment strategy), made by the LLM, with no deterministic re-derivation or override anywhere in the call chain.** The only thing computed deterministically afterward is the HYBRID stock/production *split* (`compute_fulfillment_split`, `graph.py:1624`), not the strategy choice itself. |
| **`production_planning_agent.py`** | production-plan verdict | materials/routing/simulated-schedule facts already computed by scheduling-service | `decision.status` (PASS/WARNING/MATERIAL_SHORTAGE) and `decision.explanation` | The **real `verdict`** (`graph.py:1942-1956`) is computed **entirely from deterministic facts** (`has_shortage`, `operations_not_placed`, `needed_extended_horizon` — all sourced from scheduling-service). `decision.status` is consulted only in the final `else` branch, and even then clamped to PASS/WARNING only. | C, **VERIFIED SAFE** — this is the one case in the codebase where a system-prompt's claim of being deterministically overridden was independently traced and confirmed true in the calling code. |
| **`procurement_agent.py`** | vendor selection for a material shortage | real vendors-per-component (`vendor_id, lead_time_days, unit_cost`) and target completion date | **`choice.vendor_id` flows directly into `erp.create_purchase_order(..., vendor_id=...)`** (`graph.py:1802-1811`), creating a real `PurchaseOrder` with a real committed cost | **YES — the only guard is an existence check** (`graph.py:1796-1801`: the chosen vendor must be a real vendor for that component) — **the actual cost/lead-time tradeoff reasoning (cheaper-but-slower vs faster-but-pricier) is trusted from the LLM, never deterministically re-verified** | **G — Mutation/commit authority.** This is the most consequential unguarded finding: it directly creates a real financial commitment. |
| `inventory_agent.py`, `quality_agent.py` | read-only Q&A (`inventory_quality_request_node`, `graph.py:419-430`) | a shortage list / quality-inspection list already computed deterministically | `decision.explanation` becomes chat response text only — **no write, no branch, no status field consumed elsewhere** (verified: `graph.py:425,430` return `decision.explanation` directly as the response) | **No** | C, VERIFIED SAFE, confirms this session's own memory record ("read-only verdict-writer agents") |
| `negotiation_agent.py` | discount-request extraction | customer message | `NegotiationDecision` (requested_discount_percent / requested_price / summary) — prompt explicitly disclaims pricing authority | **This function has ZERO call sites anywhere in the app** (`grep -rn "negotiation_agent(" app --include="*.py"` outside its own definition and tests returns nothing) | **Dead code — defined, never invoked.** Not a risk in itself, but a documentation/reality mismatch (see §9) and worth confirming isn't reachable through some path this static pass missed. |
| `configuration_agent.py`, `export_agent.py`, `consignment_agent.py`, `financial_agent.py`, `service_agent.py`, `subscription_agent.py`, `project_agent.py`, `billing_agent.py`, `post_sales_agent.py` | various post-sales/vertical workflows | — | — | **UNKNOWN — not individually traced to their call sites this pass.** PLAN.md claims a consistent pattern ("Billing Agent decides terms/notes, `erp.create_invoice()` computes the amount deterministically") for several of these, matching the verified pattern seen in `quotation_agent`/`production_planning_agent`, but this was **not independently verified for each file** and should not be assumed true without checking. | **PARTIAL/UNKNOWN** |

### Summary of what can influence a write, independently verified this session
- **Fulfillment strategy selection: LLM-controlled, unguarded.** (`fulfillment_agent` → `fulfillment_router`)
- **Vendor/purchase-order selection: LLM-controlled, only existence-checked, not cost/time-optimality-checked.** (`procurement_agent` → `erp.create_purchase_order`)
- **Workflow entry-point routing: LLM-controlled, one narrow deterministic override.** (`process_agent` → `entry_router`)
- **Credit approval: deterministic, no LLM** (`app/tools/credit_tools.py:check_credit` — plain arithmetic over mock-ERP rows; VERIFIED by reading the function; `credit_router`, `graph.py:1596-1599`, branches on its boolean result, not on any LLM output).
- **Production feasibility verdict: deterministic, LLM contributes explanation text only.** (`production_planning_agent`, verified above)
- **Scheduling/machine/time-slot placement: zero LLM involvement anywhere** — confirmed by grepping `manufacturing_services.py`, `production_tools.py`, and `web/src/lib/apsAgent.ts` for any Groq/LLM reference (none found); `apsAgent.ts`'s own header comment states this explicitly ("No LLM anywhere in this file, and no scheduling math of its own") and was independently corroborated by the absence of any LLM import.

---

## 5. Exception / Failure Inventory

Two distinct failure-handling populations were found: (A) Kafka `publish()` calls after a DB write with no surrounding try/catch, and (B) explicit `except`/`catch` blocks.

### A. Unguarded `publish()` after a committed write (TypeScript)

**Mechanism (VERIFIED, `packages/shared/src/http.ts`):** every TS service uses `express-async-errors` + a shared `registerErrorHandler` that turns any rejected promise from an async route handler into an HTTP 500 (or 409 for a Prisma P2002). Express 4 would otherwise crash the whole process on an unhandled rejection — this is explicitly why `express-async-errors` is there (comment in `http.ts`, confirmed true of Express 4's actual behavior).

**The pattern (VERIFIED by reading 7 call sites + confirming no local try/catch in the 8 lines preceding each):**

| File:line | DB write already committed | `publish()` call | Local try/catch? | Consequence if publish throws |
|---|---|---|---|---|
| `order-service/src/app.ts:453-457` | `prisma.productionOrder.create` | `ORDERS_PRODUCTION_CREATED` | No | Row exists; caller gets HTTP 500 and believes creation **failed** |
| `order-service/src/app.ts:479-489` | `prisma.productionOrder.update` | `ORDERS_PRODUCTION_UPDATED` | No | Same — update committed, caller told 500 |
| `inventory-service/src/index.ts:53` | (inventory read/write context) | `INVENTORY_SHORTAGE_DETECTED` | No | — |
| `inventory-service/src/index.ts:214` | — | `INVENTORY_MOVEMENT_RECORDED` | No | — |
| `machine-service/src/index.ts:106,121` | `machine`/`machineEvent` write | `MACHINES_STATUS_CHANGED`, `MACHINES_BREAKDOWN_REPORTED` | No | — |
| `mes-integration/src/index.ts:190` | — | `INVENTORY_MOVEMENT_RECORDED` | No | — |
| `maintenance-service/src/index.ts:39` | `maintenanceOrder.create` | `MAINTENANCE_ORDERS_CREATED` | No | — |
| `iot-ingestion/src/index.ts:26` | — (no DB write — ingestion only) | `MACHINES_SENSORS` | No | Not a write-path case |
| `scheduling-service/src/pipeline.ts:1075` | `schedule` publish | `SCHEDULE_PUBLISHED` | No | — |

**Table:**

| File | Function | Pattern | Write path? | Multi-store? | Durable recovery? | SAFE/UNSAFE | Reason |
|---|---|---|---|---|---|---|---|
| `order-service/src/app.ts` | `POST /orders` | publish-after-commit, no try/catch | Yes | Yes (Postgres + Kafka) | No | **UNSAFE** | A broker hiccup turns a successful `ProductionOrder` creation into an HTTP 500; caller has no idempotency key here and may retry, risking a duplicate order |
| `order-service/src/app.ts` | `PATCH /orders/:id` | same | Yes | Yes | No | **UNSAFE** | Same mechanism on every status/quantity update |
| `machine-service/src/index.ts` | breakdown/status report | same | Yes | Yes | No | **UNSAFE** (same class — not individually re-verified for a local catch at every one of these lines beyond the ±8-line check) |
| `inventory-service`, `mes-integration`, `maintenance-service`, `scheduling-service/pipeline.ts` | various | same | Yes (except iot-ingestion) | Yes | No | **UNSAFE** (same class, same caveat) |
| `scheduling-service/src/index.ts:205-226` | `POST /scheduling/operations/:id/exceptions` | **wrapped** try/catch, but the catch is shared with the DB write and returns a **misleading error** | Yes | Yes | No | **UNSAFE** — if `prisma.productionException.create` *succeeds* but the subsequent `publish()` throws, the catch block (`graph.py` pattern, actually `index.ts:222-225`) returns `404 "Scheduled operation not found"` — **factually wrong**, since the operation was found (its exception row was just created) |
| `scheduling-service/src/index.ts:275-318` | `POST /scheduling/operations/:id/quality-inspections` | no try/catch at all around either of its two `publish()` calls | Yes | Yes | No | **UNSAFE**, same class as order-service |

**Kafka broker reachability (VERIFIED this session):** `nc -z localhost 9092` succeeded — the broker is actually up in this dev environment, so these failure paths are currently latent, not actively firing.

### B. Explicit `except Exception` sites (Python, `agent-orchestrator`)

18 `except Exception` occurrences in non-test app code (VERIFIED count via grep). Of these, exactly 3 are a bare `except Exception: pass` with **zero logging** (VERIFIED by grepping for the exact `except Exception:` → `pass` adjacency):

| File | Function | Pattern | Write path? | Multi-store? | Durable recovery? | SAFE/UNSAFE | Reason |
|---|---|---|---|---|---|---|---|
| `app/routers/approvals.py:147-150` | REJECTED-decision cleanup | `except Exception: pass` | Yes (`mfg.delete_production_order`) | Yes (order-service DB) | **No — not even logged** | **UNSAFE** | A human rejects an order; if deleting the orphaned `PLANNED` ProductionOrder fails, the API still returns `{"resolved": True, "status": "REJECTED"}` — the row silently lingers forever, competing for machine capacity in future scheduling runs, with no log line and nothing to alert anyone |
| `app/graph.py:861-864` | a second, separate stale-production-order cleanup path | `except Exception: pass` | Yes (same `mfg.delete_production_order`) | Yes | **No** | **UNSAFE** | Confirmed as the *same pattern, a second time* — the code's own comment cross-references approvals.py's case ("same cleanup principle as a straight REJECT"), i.e. this is a repeated pattern, not a one-off |
| `app/db.py:343-344` (`mark_execution_failed`) | recording a failure reason in the audit trail | `except Exception: pass` | Yes (one store: `AgentPipelineRun.executionResult`) | No | N/A | **SAFE** | Explicitly documented and verified: this swallow only protects the *audit log of an already-happening failure* — the real error is independently raised/returned to the caller by the code that calls this function, so swallowing here cannot turn a failure into an apparent success |
| `app/routers/pipeline.py` (6 sites: `_try_create_run`, `_try_finish_run`, `_try_log_stage`, `list_pipeline_runs`, `list_pending_approvals`, `get_pipeline_run`) | run-tracking/observability | `except Exception:` + `logger.warning` | Yes, but only to the `AgentPipelineRun` observability table | No | N/A | **SAFE** | All logged; explicitly documented as "fine to degrade silently" since it's pure observability — the one place this *would* matter (binding a real human-approval gate) is deliberately **not** swallowed: `pipeline.py:88-93` raises `HTTPException(503)` instead, specifically because an unrecorded approval gate would be unsafe |
| `app/routers/approvals.py:174-179` | post-approval fulfillment | `except Exception as exc:` → converted to a structured `FULFILLMENT_FAILED` status dict, not re-raised | Yes (fulfillment side-effects) | Yes | No formal retry, but the failure is **visibly reported** to the caller | **SAFE-leaning** | The Sales Order itself is already real and valid; the comment explains this is a deliberate "report the gap honestly rather than raising" — the caller is told fulfillment failed, never told it silently succeeded |
| `app/routers/approvals.py:237-241` | reschedule execution | `except Exception as exc:` → `db.mark_execution_failed` + re-raised as `HTTPException(502)` | Yes | Yes | No | **SAFE** | Fails loudly by design |
| `app/graph.py:750,785,807,2013,2065` | dual-write / fulfillment-line patch best-effort paths | `except Exception:` + `logger.warning(..., exc_info=True)` | Yes (Postgres side of a dual-write) | Yes (mock-ERP + Postgres) | No automated retry, but logged, and the primary mock-ERP write is never at risk (by construction — these run only after it already succeeded) | **SAFE-by-design, not independently stress-tested** | Matches PLAN.md's documented dual-write philosophy: Postgres is a best-effort secondary record; a failure here means "the new Postgres row wasn't written this time," an honestly-reportable state (`available: false` on read), not a masked error |
| `app/routers/sales_orders.py:88-97` (`_fetch_capacity`) | one leg of an `asyncio.gather` | `except Exception:` → returns `(None, "...unavailable...")` | No (read-only) | N/A | N/A | **SAFE** | Explicitly isolates one of several parallel reads; the `None` is surfaced to the UI as "missing," not hidden |

**Not exhaustively checked:** `bare except:`, `catch {}` (TS), and `continue`-after-exception patterns outside Kafka publish sites were not separately swept across all 18 services this pass — **PARTIAL coverage**, scoped to the two populations above (Kafka-adjacent TS, and all Python `except Exception` sites in non-test `agent-orchestrator` code).

---

## 6. Event / Kafka Consistency

**Client (VERIFIED, `packages/shared/src/kafka.ts`):** real `kafkajs` client, one producer/one admin per process, `logLevel.NOTHING`. **No outbox table anywhere in the schema** (confirmed — `schema.prisma` has no model resembling an outbox/event-journal pattern). `publish()` is a direct, un-batched `producer.send()` call — not transactional with any DB write (no two-phase commit, no outbox-relay).

**Producer table:**

| Producer | DB change announced | Event | Transaction boundary | Outbox? | Atomic with the write? | Failure behavior |
|---|---|---|---|---|---|---|
| `order-service: POST /orders` | new `ProductionOrder` | `ORDERS_PRODUCTION_CREATED` | Outside — publish happens after the `create()` promise resolves, no `$transaction` wrapping both | No | **No** | Uncaught → HTTP 500 to caller despite the write having committed (§5) |
| `order-service: PATCH /orders/:id` | `ProductionOrder` status/qty update | `ORDERS_PRODUCTION_UPDATED` | Outside | No | No | Same |
| `scheduling-service: pipeline.ts` | new `Schedule` row | `SCHEDULE_PUBLISHED` | Outside | No | No | Uncaught → 500 (not independently re-verified for a wrapping catch at this exact call site beyond the ±8-line check) |
| `scheduling-service: POST .../exceptions` | `ProductionException` | `OPERATIONS_EXCEPTION_REPORTED` | Inside a try/catch, but the catch **misreports** the error (§5) | No | No (write and publish both inside one try, but not one Postgres transaction with the Kafka call — a publish failure after a successful write is misclassified as "not found") | Misleading 404 |
| `scheduling-service: POST .../quality-inspections` | `QualityInspection` + possibly `ProductionException` | `QUALITY_INSPECTION_RECORDED`, `OPERATIONS_EXCEPTION_REPORTED` | Outside, no try/catch at all | No | No | Uncaught → 500 |
| `machine-service` | `machine`/`machineEvent` write | `MACHINES_STATUS_CHANGED`, `MACHINES_BREAKDOWN_REPORTED` | Outside | No | No | Uncaught → 500 |
| `inventory-service` | `inventory`/`inventoryMovement` write | `INVENTORY_SHORTAGE_DETECTED`, `INVENTORY_MOVEMENT_RECORDED` | Outside | No | No | Uncaught → 500 |
| `mes-integration` | `inventoryMovement` | `INVENTORY_MOVEMENT_RECORDED` | Outside | No | No | Uncaught → 500 |
| `maintenance-service` | `maintenanceOrder` | `MAINTENANCE_ORDERS_CREATED` | Outside | No | No | Uncaught → 500 |
| `iot-ingestion` | (no DB write) | `MACHINES_SENSORS` | N/A | N/A | N/A | Not a write-consistency case |

**Consumer table:**

| Consumer (groupId) | Topic(s) | Handler | Side effects | Idempotency protection | Duplicate handling | Retry/DLQ |
|---|---|---|---|---|---|---|
| `scheduling-service-order-updates` | `ORDERS_PRODUCTION_UPDATED` | re-plan affected orders | writes `ScheduledOperation`/`ResourceReservation` | **UNKNOWN** — not traced this pass | **UNKNOWN** | **UNKNOWN** — kafkajs default retry only; no dead-letter topic found anywhere in the repo (`grep` for "dead letter"/"DLQ" found nothing) |
| `scheduling-service-breakdown` | `MACHINES_BREAKDOWN_REPORTED` | `blockCapacity` + `autoReschedule` | writes schedule state | UNKNOWN | UNKNOWN | Same |
| `scheduling-service-machine-available` | `MACHINES_STATUS_CHANGED` | re-plan | writes | UNKNOWN | UNKNOWN | Same |
| `scheduling-service-maintenance` | `MAINTENANCE_ORDERS_CREATED` | capacity block | writes | UNKNOWN | UNKNOWN | Same |
| `machine-service` | `MACHINES_SENSORS` | persist `SensorReading` | DB write | UNKNOWN | UNKNOWN | Same |
| `mes-integration` | `SCHEDULE_PUBLISHED` | sync completions | DB write | UNKNOWN | UNKNOWN | Same |
| `inventory-service` | `ORDERS_PRODUCTION_CREATED` | shortage scan | DB write/publish | UNKNOWN | UNKNOWN | Same |
| `notification-service` (alerts) | `MACHINES_BREAKDOWN_REPORTED`, `INVENTORY_SHORTAGE_DETECTED`, `MAINTENANCE_ORDERS_CREATED` | send email (Resend) | External side effect, no DB write | None visible — a replayed message would re-send the email | UNKNOWN | Same |
| `notification-service-dashboard-relay` | `ORDERS_PRODUCTION_CREATED`, `ORDERS_PRODUCTION_UPDATED`, `SCHEDULE_PUBLISHED` | SSE broadcast to connected browsers | No DB write | N/A (idempotent by nature — a duplicate just re-renders) | N/A | Same |

**No consumer exists for 3 of the declared topics** (VERIFIED — `OPERATIONS_EXCEPTION_REPORTED`, `INVENTORY_MOVEMENT_RECORDED`, `QUALITY_INSPECTION_RECORDED` have zero `subscribe()` call sites anywhere; this exactly matches `topics.ts`'s own comments stating "No consumer yet" for all three — a rare case where the documentation comment and the code agree).

**Broker availability:** reachable on `localhost:9092` this session (VERIFIED via `nc -z`). Behavior if the broker were down was not empirically tested (would require stopping the broker, out of scope for a read-only baseline) — its *code-level* behavior (uncaught exception → request fails, per §5) was established by static reading, not by inducing the failure live.

---

## 7. Scheduling Ground Truth

**Inspected:** `services/scheduling-service/`, `packages/domain/src/`, `services/optimization-service/`, `services/optimization-solver/`, `web/src/lib/apsAgent.ts`, `services/agent-orchestrator/app/integrations/manufacturing_services.py`, `services/agent-orchestrator/app/agents/production_planning_agent.py`, `services/agent-orchestrator/app/tools/production_tools.py`.

**Directory contents (VERIFIED):**
- `packages/domain/src/`: `capacity-engine.ts`, `constraint-engine.ts`, `dispatch-rules.ts`, `priority-score.ts`, `shift-expansion.ts`, `scheduling-types.ts` — a shared **library** of scheduling primitives, imported by `scheduling-service` as an in-monorepo package. Not a standalone service.
- `services/scheduling-service/src/`: `index.ts` (REST API, 1106+ lines), `pipeline.ts` (the actual run — forward/backward/bottleneck placement, calls into `packages/domain/src/*`), `cpm.ts` (Critical Path Method).
- `services/optimization-service/src/`: `index.ts`, `load-balancing.ts`, `tsp.ts` — a separate TS service, called by `scheduling-service/src/pipeline.ts` as an optional step.
- `services/optimization-solver/`: Python/FastAPI + OR-Tools `cp_model` (`main.py`) — called only by `optimization-service`. **Its own Dockerfile states it is not built/run in this environment (no Docker).**

**The actual call chain (VERIFIED by reading `pipeline.ts:1045-1528`):**
```
scheduling-service/pipeline.ts: core deterministic placement
  (forward/backward/bottleneck, using capacity-engine.ts + constraint-engine.ts
   + dispatch-rules.ts + cpm.ts — this is what produces the real ScheduledOperation rows)
→ "Step 10: Optimisation Pass — best-effort call to optimization-service"
    (pipeline.ts:1062, 1518: POST http://localhost:4006)
    try { ... } catch (error) {
      logger.warn("Optimization pass skipped (optimization-service unavailable)", ...)
    }
→ optimization-service → optimization-solver (CP-SAT), port 4007
```
The optimization pass is a **best-effort refinement layer that runs AFTER the core schedule already exists** and is explicitly allowed to fail silently (logged warning, schedule unaffected) if `optimization-service`/`optimization-solver` is unreachable. Since `optimization-solver` is confirmed not runnable in this dev environment, **this pass is, in practice, currently always a no-op here.**

**Is there more than one scheduler? NO.** The apparent plurality of scheduling-related files (`scheduling-service`, `optimization-service`, `optimization-solver`, `apsAgent.ts`, `manufacturing_services.py`, `production_planning_agent.py`, `production_tools.py`) resolves, on inspection, to:
- **One authoritative scheduler**: `scheduling-service` + `packages/domain/src/*` (the only code that actually writes `ScheduledOperation`/`ResourceReservation` rows for the main placement path).
- **One optional refinement solver** (`optimization-service` → `optimization-solver`), a genuine composition/wrapper layer, not a competing authority — confirmed by its own best-effort try/catch and its currently-undeployed status.
- **`apsAgent.ts`** (`web/src/lib/`): a TS composition module on the APS Platform side that calls the real microservices (routing/machine/order/scheduling/inventory) — **not an LLM agent despite the name**, and not a scheduler itself; its own header comment states "No LLM anywhere in this file, and no scheduling math of its own" (VERIFIED — zero LLM imports found in the file).
- **`manufacturing_services.py`/`production_tools.py`** (Python side): HTTP client wrappers that call the same real TS services. Zero LLM imports (VERIFIED by grep).
- **`production_planning_agent.py`**: produces explanation text only; the real feasibility verdict is deterministically computed and the LLM's own status is overridden/clamped (VERIFIED, §4).

**LLM involvement in machine/time-slot/capacity/feasibility decisions: NONE found.** Every file that actually touches scheduling math or resource assignment was checked for an LLM import; none has one.

### SCHEDULING AUTHORITIES
- **Number: 1** (scheduling-service, using packages/domain/src's engine)
- **Authoritative implementation:** `services/scheduling-service/src/pipeline.ts` + `cpm.ts`, using `packages/domain/src/{capacity-engine,constraint-engine,dispatch-rules,priority-score,shift-expansion}.ts`
- **Solver:** `services/optimization-solver` (OR-Tools CP-SAT) via `services/optimization-service` — optional, best-effort, currently undeployed in this environment (no Docker)
- **LLM involvement:** None in the scheduling/feasibility decision itself. `production_planning_agent` (LLM) contributes human-readable explanation text only, with its status field clamped/overridden by deterministic facts.
- **Duplicate scheduler risk:** Low. The only real risk is a naming/documentation one: `apsAgent.ts`'s name invites the assumption it's an AI agent; it is confirmed deterministic composition code.
- **Evidence:** `pipeline.ts:1045,1062,1518,1525,1528`; `graph.py:1936-1956`; grep results for LLM imports in `manufacturing_services.py`, `production_tools.py`, `apsAgent.ts` (all empty); `optimization-solver/Dockerfile`'s own "not built/run" comment.

---

## 8. Business Decision Map

| Decision | File/function | Deterministic or LLM | Data source | Can it mutate state? |
|---|---|---|---|---|
| Credit approval | `app/tools/credit_tools.py:check_credit` | **Deterministic** (plain arithmetic, no LLM) | mock_erp.xlsx SalesOrders sheet sum | Yes — gates `credit_router` → `credit_hold_node`, which sets `SalesOrder.status = CREDIT_BLOCKED` |
| Fulfillment strategy (MTS/MTO/CTO/HYBRID/THIRD_PARTY/INTERCOMPANY) | `app/agents/fulfillment_agent.py` → `fulfillment_decision_node` | **LLM, unguarded** | stock_total, can_produce, product_configurable, lead_time_days (all deterministic inputs; the *classification* itself is the LLM's call) | **Yes, directly** — `fulfillment_router` dispatches on the raw LLM output to decide stock reservation vs. ProductionOrder creation vs. vendor sourcing |
| Fulfillment HYBRID split (units from stock vs. to produce) | `app/tools/fulfillment_tools.py:compute_fulfillment_split` | **Deterministic** | the (LLM-chosen) strategy + stock_total + quantity | Yes, but only the arithmetic — not the strategy choice |
| Inventory availability / shortage detection | `inventory-service` (`check_shortages`, Prisma reads) | Deterministic | real `Inventory`/`BOM` rows | Read-only for the check itself; triggers `INVENTORY_SHORTAGE_DETECTED` |
| Vendor selection for a material shortage | `app/agents/procurement_agent.py` → `erp.create_purchase_order` | **LLM, only existence-checked** | real `VendorProduct` rows (vendor_id/lead_time/cost) per component | **Yes, directly** — creates a real `PurchaseOrder` with the LLM-chosen vendor's cost/lead-time |
| Production feasibility verdict (PASS/MATERIAL_SHORTAGE/PLANNER_REVIEW/WAITING_FOR_PRODUCTION_SLOT) | `graph.py` (verdict logic) + `production_planning_agent.py` (explanation only) | **Deterministic** (verified override) | scheduling-service's real materials/routing/simulated-schedule result | Yes — gates whether a `ProductionOrder` is committed |
| Machine/operator/time-slot assignment | `scheduling-service/pipeline.ts` + `packages/domain/src/*` | **Deterministic** | real `Machine`/`Operator`/`WorkCenter`/`ResourceReservation` state | Yes — the actual `ScheduledOperation`/`ResourceReservation` writes |
| No-overlap / resource-conflict enforcement | Postgres GiST exclusion constraints (`resource_reservation_machine_no_overlap`, `resource_reservation_operator_no_overlap`) | **Deterministic, DB-enforced** (VERIFIED live in the actual database, not just the migration file — see §1/§7 verification) | — | Rejects a conflicting `INSERT`/`UPDATE` outright |
| Promise/delivery dates | `_deliver_and_bill` (stock leg), `_execute_production_plan` (production leg) | **Deterministic** — real `confirmed_delivery_date`/scheduled-end dates, never invented (per code comments, consistent with every date-handling site read this session) | mock-ERP delivery creation / real `scheduledEnd` from scheduling-service | Yes |
| Approval requirements (create_order, RESCHEDULE_PRODUCTION gates) | `app/db.py` (`AgentPipelineRun.approvalStatus` state machine), `app/security.py` (`require_role("PLANNER")`) | **Deterministic** | server-stored `approvalPayload`, never re-trusted from the client at resolve time | Yes — the entire approve/reject/execute state machine |
| Order state transitions (`SalesOrder`/`FulfillmentLine` status) | `order-service/src/app.ts` (`deriveSalesOrderStatus`, `FULFILLMENT_LINE_TRANSITIONS`) | **Deterministic**, enforced via an explicit transition table + row locking | — | Yes |
| Workflow entry-point routing (PRE_SALES/DIRECT_SALES/.../FINANCIAL) | `process_agent.py` → `entry_router` | **LLM, one narrow deterministic override** | intent + customer/product context + resolved_references | **Yes, indirectly** — determines which workflow (and write path) executes |

---

## 9. Documentation vs Reality

### A. Claims in documentation the code does NOT currently support
- **README.md** describes a generic `create-next-app` bootstrap project ("First, run `npm run dev`... Open http://localhost:3000") — it does not mention this repository's actual purpose, services, or architecture at all. This is not a contradiction so much as a near-total omission: **the root README describes nothing about what this repository actually is.**
- **PLAN.md's "Build order"** step 17 ("Replace mock ERP tools with real adapters last, once the model is stable") describes a future `SAPAdapter`/`OracleAdapter` — confirmed not built (`app/erp/mock_erp_adapter.py` is still the only `ERPAdapter` implementation; PLAN.md itself says as much in its own closing section, so this is PLAN.md being self-consistent, not a contradiction — included here because a careless read of the build-order section alone could wrongly imply it's done).
- **`production_planning_agent.py`'s own system prompt** claims "the calling service decides that deterministically... and overrides your status when it disagrees with you" — this claim was independently **verified true** by reading `graph.py:1936-1956`. Included here as a positive case: not every in-code claim needs to be treated with suspicion forever once actually checked.

### B. Capabilities present in code that documentation does NOT mention
- **`negotiation_agent.py` exists, is fully implemented, and is never called from anywhere** — not mentioned as dead/incomplete in PLAN.md or SESSION_SUMMARY.md.
- The **Kafka publish-after-write exception-handling gap** (§5/§6) is not documented or flagged anywhere in PLAN.md, SESSION_SUMMARY.md, or in-code comments at the affected call sites (contrast with the `_dual_write_order_and_fulfillment` best-effort pattern, which *is* explicitly documented as a deliberate design choice).
- **Two bare `except Exception: pass` orphaned-ProductionOrder cleanup sites** (§5) are commented as intentional (the comments explain *why* cleanup is attempted) but neither comment acknowledges that a cleanup failure is itself silently swallowed.
- The **`apsAgent.ts` naming choice** ("APS Agent") is not flagged anywhere as potentially misleading about whether it's an LLM agent (it isn't).

### C. Claims that are partially true
- PLAN.md's "Agents propose, tools execute — never let an LLM directly mutate committed data" (Safety rules section) is **true for the majority of agents checked** (intent, context, request_understanding, inventory, quality, production_planning — all verified not to directly commit), but **not true for `fulfillment_agent`'s strategy choice or `procurement_agent`'s vendor choice** — both flow into a real write with only an existence/sanity check, not a deterministic "propose, then tools decide" split. This is the single most important documentation-vs-reality finding in this audit.
- SESSION_SUMMARY.md's "Scheduling is not idempotent... Documented as a known behavior, not fixed" is confirmed as an honest, accurate self-report (not independently re-verified live this pass, but the framing matches this audit's own finding that re-running scheduling has no dedup/idempotency guard anywhere in the Kafka consumer layer either — see §6's "UNKNOWN" idempotency cells).

### D. Unknowns that require runtime investigation
See §10.

---

## 10. Unknowns

- **agent-orchestrator's actual production port/entry convention** — no Dockerfile, no documented port; working only because this session happened to start it with `--port 8000` by convention.
- **Consumer idempotency/duplicate-handling for every Kafka consumer** (§6) — not traced into each handler's body this pass; kafkajs's own default at-least-once delivery semantics mean a redelivered message's effect on, e.g., `scheduling-service-breakdown`'s `blockCapacity`/`autoReschedule` call is unverified.
- **Dead-letter/retry topic existence** — grep for "dead letter"/"DLQ" found nothing repo-wide; whether this means no DLQ exists at all, or one exists under a different name, was not exhaustively ruled out.
- **`analytics-service` and `iot-ingestion`'s real data source** — no Prisma usage found in either; not read in full to determine what they actually persist to (if anything) or whether they're intentionally stateless passthroughs.
- **Whether the 9 unverified agents** (`configuration_agent`, `export_agent`, `consignment_agent`, `financial_agent`, `service_agent`, `subscription_agent`, `project_agent`, `billing_agent`, `post_sales_agent`) follow the same "propose only" pattern as the verified-safe ones, or the same "direct, unguarded write" pattern as `fulfillment_agent`/`procurement_agent` — genuinely unknown without individually tracing each to its call site.
- **Whether Kafka broker-down failure actually manifests as described in §5/§6** — established by static code reading (what the code would do), not by empirically killing the broker and observing a live 500.
- **Full outbound-HTTP-call map per service** (§2's stated gap) — not built endpoint-by-endpoint for all 18 services.
- **Exact current pytest exit code for agent-orchestrator's suite** — inferred from pytest's standard convention, not independently re-captured.
- **Whether `routing-service` (port 4002) and the remaining unlisted services actually run cleanly in this environment** — only `order-service`, `scheduling-service`, `agent-orchestrator`, and (from earlier in this session) `web` were empirically confirmed live/running; the rest were analyzed statically only.

---

## 11. Risks Found

Ranked by how directly each touches a Hard Invariant from this stage's own brief, or causes a false success/failure signal:

1. **Fulfillment strategy is an LLM decision with no deterministic override** (`fulfillment_agent.py` → `fulfillment_router`). Directly relevant to Hard Invariant #3 ("Do not move... fulfillment strategy... logic into an LLM") — this is not a hypothetical risk to guard against going forward, it is the **existing, current state of the code**.
2. **Vendor/purchase-order selection is an LLM decision, existence-checked but not cost/time-optimality-checked** (`procurement_agent.py` → `erp.create_purchase_order`). Creates a real financial commitment (a `PurchaseOrder` with a real unit cost) on the LLM's own tradeoff reasoning.
3. **Systemic publish-after-commit-with-no-catch pattern across at least 7 producer call sites** in TypeScript services, which — given `express-async-errors` turns any such rejection into an HTTP 500 after the DB write already committed — means a Kafka hiccup can make a *successful* write look like a *failed* one to every caller, with no idempotency key at most of these endpoints to protect a resulting retry.
4. **Two independent bare `except Exception: pass` (zero logging) sites**, both guarding the same class of operation (deleting an orphaned `ProductionOrder` on rejection) — a failure here is invisible: not logged, not retried, not surfaced to the human who just rejected the order.
5. **One exception-handling site that returns an actively incorrect error message** (`scheduling-service POST .../exceptions`'s catch returning 404 "not found" when the real cause was a downstream publish failure after a successful creation).
6. **Zero outbox/dead-letter infrastructure** for an event system that several real downstream effects (rescheduling on breakdown, dashboard relay, alerting) depend on — currently masked by the broker actually being up and no failure having been induced.
7. **15 of 18 services have no automated tests at all.**
8. **No root-level test or dev-orchestration command** — every verification in this baseline required manually discovering and setting `DATABASE_URL`/`INTERNAL_SERVICE_TOKEN`/`PATH` per service.
9. **Workflow entry-point routing is LLM-controlled beyond one narrow historic-bug override** — lower severity than #1/#2 since most `entry_type` values correspond to broad, recoverable categories rather than a direct financial/production commitment, but still a real instance of an LLM decision gating which write-path runs.
10. **17 pre-existing agent-orchestrator test failures**, not diagnosed (out of scope for this stage) — their presence means the test suite cannot currently be used as a clean regression signal without first separating known-bad from newly-broken.

---

## 12. Recommended Next Gate

Per this stage's own instructions, this is a list of what should be *investigated or decided next* — **not a plan to implement anything.**

1. **Decide, explicitly, whether fulfillment-strategy and vendor-selection authority should move to a deterministic function with the LLM only producing the explanation** (matching the already-proven `production_planning_agent` pattern) — this is a product/architecture decision for the user to make, not something to infer and build unasked. If the answer is yes, `production_planning_agent`'s verified-safe pattern (deterministic fact → verdict, LLM → explanation only, output clamped) is the existing in-repo template to follow.
2. **Audit the remaining 9 unclassified agents** (`configuration`, `export`, `consignment`, `financial`, `service`, `subscription`, `project`, `billing`, `post_sales`) against the same "does its output reach a write with no deterministic check" question — this baseline deliberately stopped short of tracing all of them.
3. **Decide whether the publish-after-commit pattern needs a fix** (e.g., wrap write+publish in a try/catch that still returns success for the write while logging/queuing the publish failure, or adopt a real outbox) — and if so, scope it as its own stage, since it touches a very wide, repeated pattern across 7+ files in multiple services.
4. **Decide what the two orphaned-ProductionOrder-cleanup `except: pass` sites should do on failure** (at minimum, log; possibly a reconciliation job) — small, isolated, well-understood fix candidates once prioritized.
5. **Investigate the 17 pre-existing agent-orchestrator test failures** to separate "known, already-tracked, pre-existing" from anything that might have silently regressed — this baseline did not diagnose root causes, only confirmed they are not new.
6. **Decide whether `negotiation_agent.py` is a deliberately-staged, not-yet-wired feature, or should be removed** — currently dead code with no caller.
7. **Clarify agent-orchestrator's and the two Next.js apps' (`web`, `frontend`) intended port/process convention** — the current state (no Dockerfile/docker-compose, two Next.js apps whose `.env.local` files assume fixed-but-uncoded ports that collided at least once empirically this session) should be made explicit before any infrastructure work proceeds.

**Do not proceed to Stage 01 or any implementation based on this document until it has been reviewed.**
