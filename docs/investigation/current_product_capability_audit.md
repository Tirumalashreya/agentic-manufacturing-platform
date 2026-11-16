# Current product capability audit (HEAD `e65a291` + dirty tree)

Scale (VERIFIED by file counts): 18 services under `services/`, Prisma schema of 1,587 lines and 59 models with 34 migrations, two Next.js apps (Ledger = `frontend/`, about 8.6k lines; APS = `web/`, about 11.4k lines), and the Python agent-orchestrator (`app/graph.py` alone is 3,322 lines, with 24 agent modules and 26 tool modules).

Status legend: **Complete** (schema + logic + tests seen), **Partial**, **Thin** (exists, shallow), **Absent**. "Tests" is a static count of test functions; none were run for this audit.

## A. Ledger / commercial

| Capability | Status | Evidence | Gap |
|---|---|---|---|
| Customer, SalesOrder, OrderLine, FulfillmentPlan/Line | Complete | `schema.prisma` models; atomic creation in one `$transaction` (contract A2); order-service has 99 test cases | `Customer` is also written by erp-integration (documented exception) |
| Fulfillment strategies (MTS etc.), HYBRID | Complete (model), Partial (decision) | `enum FulfillmentStrategy`; agent decides | The decision is made by an LLM agent (baseline of Oct 5). The current gate **was not re-verified at HEAD**; `fulfillment_agent.py` only says amounts are computed elsewhere |
| Credit validation | Complete | `tools/credit_tools.py`, `test_credit*.py` | Excel-backed |
| Promise date + Promise Risk Inbox | Complete | order-service `/sales-orders/promises`; scheduling `checkPromiseImpact` (`pipeline.ts:177`); promise-impact tests | |
| Delivery and invoice | Partial | Postgres `Delivery`/`Invoice` dual-write from Excel (`delivery_tools.py`, `billing_tools.py`); `postgres_synced` flag; "never claimed atomic" | Two stores; reconciliation absent |
| Returns, consignment, export, project, service, subscription | Present in Excel/agents | `post_sales_tools.py`, `consignment_tools.py`, `export_tools.py`, etc. | Excel-only domain, outside Postgres |
| Approval workflow | Complete | `approval_proposal.py` (hash-bound proposal), atomic CAS `claim_approval`, STALE state; immutable proposal migration; contract D1 | |

## B. APS / manufacturing

| Capability | Status | Evidence | Gap |
|---|---|---|---|
| BOM, routing, operations, dependencies | Complete | models `BOM`, `BOMLine`, `Routing`, `RoutingOperation`, `RoutingOpDependency` | routing-service has **no tests**, 139 lines |
| Machines, work centers, calendars, shifts, holidays | Complete | models + calendar migrations (shift expansion, holiday calendar, work-center override) | |
| Production orders, status lifecycle | Complete | `ProductionOrderStatus` DRAFT→PLANNED→RELEASED→IN_PROGRESS→COMPLETED/CANCELLED | Transition enforcement location not enumerated |
| Finite-capacity scheduling | Complete (rule-based) | `pipeline.ts`: forward/backward/bottleneck modes, dispatch rules EDD/SPT/LPT/CR/ATCS/PRIORITY_SCORE (`dispatch-rules.ts`), capacity buckets in Redis, alternative work centers, 13-week horizon extendable to 26 weeks, 24h planning fence, per-plant Redis lock with fencing | Setup time is a flat per-op cost (`pipeline.ts:662`); sequence-dependent changeover is **not** in the core pipeline |
| SINGLE / AFFECTED / ALL rescheduling | Complete | `resolveScopedOrderIds` (`pipeline.ts:104`); `pipeline.affected-scope.test.ts` | ALL is a scope, not a different algorithm |
| What-if / recovery simulation | Complete | `DryRunCtx`; `pipeline.recovery-whatif.test.ts` | |
| Schedule versioning, audit, idempotency | Complete | `Schedule`, `ScheduleRun`, `ScheduleAuditLog`, `IdempotencyKey` (+ request hash) | Audit rows lack traceId on publish failure (contract known_exception) |
| Material check at placement | Partial | `checkOperationMaterial` (`pipeline.ts:1549`) | Material is checked at placement, not a netted MRP |
| Execution, good/scrap, finished-goods receipt | Complete | `ProductionCompletionStep`; `actualGoodUnits/actualTotalUnits`; atomic claim; mes-integration (16 tests) | |
| Quality inspection | Complete | `QualityInspection`; execution-time predecessor gate (memory milestone) | Rework/NCR/disposition flow absent |
| Production exceptions, OEE downtime | Complete (per memory) | `ProductionException` with `resolvedAt` | OEE ClickHouse leg untested (no Docker) |
| Materials lifecycle | Partial | `InventoryMovement` types are only GOODS_RECEIPT and GOODS_ISSUE | No reservation entity; `Inventory.qtyReserved` is a counter |
| Procurement | Partial | `Vendor`, `VendorProduct`, `PurchaseOrder` | No requisition, no supplier delay model |
| Maintenance | Thin | `MaintenancePlan`/`MaintenanceOrder`; 168-line service; one test file | |
| Optimization (CP-SAT) | Thin and not deployed | `optimization-solver/main.py`; Dockerfile states "not built/run" | See [aps_engine_architecture_review.md](aps_engine_architecture_review.md) |

## C. Agentic workflows

Verified: ORDER_PROMISE and PROMISE_RECOVERY flows, intent classification, capability selection (`capabilities/registry.py`), human approval gating, trace correlation (`trace_context.py`). There are **547 `def test_` functions** across 61 test files in agent-orchestrator. There are **no LLM evaluation datasets, no prompt versioning and no golden sets** (grep for `eval_dataset|golden|langsmith|prompt_version` returned nothing).

## Cross-cutting findings

- **Test layout**: orchestrator and order-service are well tested. Fifteen of 18 services have zero or one test file. The only CI workflow is the architecture contract (VERIFIED: `.github/workflows/` has one file). **Tests are not run in CI.**
- **Observability**: no Prometheus, OpenTelemetry or Sentry anywhere (0 files). Health endpoints exist in 8 files, readiness in 2. Trace IDs are propagated through logs only.
- **Docs vs. reality**: `docker-compose.yml` and k8s manifests are config-only and were never run ("Docker is not installed"). The orchestrator and Ledger have no Dockerfile.
- **Unverified at HEAD**: whether 17 pre-existing orchestrator test failures from the Oct 5 baseline still fail; per-handler idempotency of 8 Kafka consumers.
