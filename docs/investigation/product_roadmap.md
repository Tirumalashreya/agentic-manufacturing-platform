# Product roadmap and final answers

Estimates are engineer-weeks for one experienced engineer, rough (±50%), not commitments. "Pilot" = suitable for a controlled single-site pilot.

## Top 10 improvements (ranked)

| # | Improvement | Level | Value | Current gap | Depends on | Code areas | Effort | Pilot |
|---|---|---|---|---|---|---|---|---|
| 1 | **Outbox + idempotent consumers + DLQ** | 1 | No lost or double-applied events | G1/G2 | none | `packages/shared/src/kafka.ts`; new `OutboxEvent`, `InboxEvent` models; producers in order/scheduling/machine/inventory/mes/maintenance; 4 scheduling consumers | 3-4 | Yes |
| 2 | **CI that runs tests** (Postgres + Redis services; per-service suites; orchestrator pytest serialized) | 1 | Regression safety | G7/G14 | none | `.github/workflows/` | 1-2 | Yes |
| 3 | **Single system of record + reconciliation** for Delivery, Invoice, then SalesOrder-linked post-sales | 1 | Removes the biggest consistency risk | G3 | none | `tools/delivery_tools.py`, `billing_tools.py`, `integrations/order_domain.py`; new reconcile job | 3 | Yes |
| 4 | **Observability** (OTel traces, metrics, uniform health/ready, dashboards) | 1 | Operability | G6 | none | `packages/shared`, orchestrator | 2-3 | Yes |
| 5 | **Backup/restore + runbooks + Dockerfiles for orchestrator and Ledger** | 1 | DR, repeatable deploy | G13/G15 | none | `infra/`, new Dockerfiles | 2 | Yes |
| 6 | **Scheduler benchmark harness + KPI baseline** (makespan, tardiness, utilization, stability, runtime, violations) | 1/2 | Evidence for all later APS claims | G11 | none | new `services/scheduling-service/bench/` | 2-3 | Internal |
| 7 | **Stock reservation ledger** | 1/2 | Correct availability and shortages | G5 | #1 | `schema.prisma`, `inventory-service`, orchestrator `inventory_tools.py` | 3 | Yes |
| 8 | **Exception command center + order lifecycle timeline** (read-only composition of existing APIs) | 2 | Main differentiation (D1/D3) | fragmented screens | #1, #4 | `frontend/src/app/promise-inbox`, `web` | 4-6 | Yes |
| 9 | **Agent eval harness + prompt/model versioning; move fulfillment and vendor choice to rules if still LLM-decided** | 2 | Trustworthy agents | G12 | none | orchestrator `agents/`, `db.py` | 3-4 | Yes |
| 10 | **Product tenancy + site scoping** (and constant-time token compare, rate limiting) | 3 | Multi-factory prerequisite | G4/G9/G10 | #3 | `schema.prisma` migration, all services | 4-6 | No |

Sequence-dependent changeover in the scheduler and CP-SAT evaluation come **after #6** and only if the benchmark shows a gap that matters (see [APS review](aps_engine_architecture_review.md)).

## Per-item detail (items 1, 3, 6, 8; others follow the same template)

**#1 Outbox.** Steps: add models and migration; helper `writeWithEvent(tx, topic, payload)`; relay loop with `SELECT … FOR UPDATE SKIP LOCKED`; consumer wrapper that inserts `(consumer,eventId)` and skips duplicates inside the handler's transaction; DLQ topic after 5 attempts. Risks: relay lag; ordering per aggregate (single partition per topic today, so order holds). Tests: crash between commit and publish; duplicate delivery; poison message. Acceptance: see G1/G2.

**#3 Source of truth.** Steps: declare owner per entity; add `reconcile` script comparing Excel rows to Postgres by external id; report only; then flip write order so Postgres is first and Excel is a derived write for Delivery/Invoice. Risks: Excel flock contention; identifier mismatch (`DEL0001` vs cuid). Tests: injected Postgres failure; diff report. Acceptance: 0 unexplained diffs over 7 days.

**#6 Benchmark.** Steps: generator for seeded job-shop instances (10 to 500 ops, 3 to 20 machines, calendars, due dates); metrics; baselines EDD, SPT, ATCS from `dispatch-rules.ts` and CP-SAT offline; stability metric (percent ops moved after a disruption). Output is a table committed to docs. No solver change without it.

**#8 Command center.** Steps: one query layer joining `promises`, `ProductionException`, late/at-risk, material shortage, machine events; one list with severity and owner; drill-down timeline per order. No new write paths. Acceptance: pilot users resolve a seeded late order in ≤ N clicks (N set from a measured current baseline).

## Final answers

1. **What does Oracle do better today?** Breadth (index lists about 260 AI entries), enterprise controls, multi-site, certification, ecosystem. Verified only at the index level.
2. **Comparable functionally?** Order→fulfillment→production→completion with state and tests; approval-bound recovery; promise-risk detection; rescheduling scopes. Depth/scale untested.
3. **Biggest technical gaps?** Outbox/inbox/DLQ, Excel as live source of truth, missing CI tests, no metrics, product tenancy, reservation ledger, no scheduler benchmark.
4. **Oracle workflows to learn from?** Order exception handling, command-center-per-role, planning exception triage. Needs the per-feature pages (not read).
5. **Where can we outperform?** Unified order-to-production workspace and explainable recovery: hypotheses, unproven.
6. **Agentic:** document→order drafting, intent, explanations, recovery ranking (over engine-generated options).
7. **Deterministic:** credit, inventory, reservations, state transitions, BOM/routing, quantities, scheduling feasibility, approvals, idempotency, audit.
8. **Predictive:** promise-risk, delay, shortage, ETA, demand. Statistical first, when data exists.
9. **Human approval:** schedule commits, recovery execution, PO creation, order creation from documents, anything touching money or inventory.
10. **Build next:** items 1 to 5, then 6.
11. **Deliberately not:** sourcing/RFQ, new microservices, LLM scheduling, an agent per Oracle assistant, predictive maintenance until sensor data exists.
12. **Evidence of competitiveness:** benchmarks table, pilot task-time and recovery-acceptance metrics, chaos-test results (see [validation](validation_and_acceptance_criteria.md)).
