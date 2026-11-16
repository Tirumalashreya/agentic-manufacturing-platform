# Engineering gap analysis

Each gap lists severity (S1 pilot-blocking, S2 production-blocking, S3 scale-blocking), evidence and an acceptance criterion. See [validation_and_acceptance_criteria.md](validation_and_acceptance_criteria.md) for how each is tested.

| ID | Area | Gap | Sev | Evidence | Acceptance criterion |
|---|---|---|---|---|---|
| G1 | Reliability | No transactional outbox. Kafka publish happens after the DB commit (`publishTracked` avoids the 500 but **the event is lost** on failure) | S1 | `packages/shared/src/kafka.ts:37`; grep for "outbox" = 0 | Kill broker during 1,000 writes: 0 lost events after recovery |
| G2 | Reliability | Consumers: no dedupe (only `scheduling-service-breakdown` reads an `eventId`), no DLQ, no retry policy beyond kafkajs defaults; `subscribe()` has no try/catch around handlers | S1 | `kafka.ts:subscribe`; no DLQ matches | Replay every event twice: final state identical; poison message lands in DLQ and does not block the partition |
| G3 | Data | Excel is a live source of truth for post-sales; Postgres dual-write is best effort | S1 | `delivery_tools.py` `postgres_synced`; billing similarly | Nightly reconciliation reports 0 unexplained diffs; each entity has one declared system of record |
| G4 | Multi-tenant | `Product` is global (`sku @unique`, no `enterpriseId`) | S3 | `schema.prisma:374` | Two enterprises create the same SKU independently |
| G5 | Data | Stock reservation is a counter; `InventoryMovement` types are only GOODS_RECEIPT/GOODS_ISSUE | S2 | `schema.prisma:1117,1202` | Every reserved unit traceable to an order line; sum(reservations) = `qtyReserved` |
| G6 | Observability | No metrics, no tracing backend; logs only | S2 | grep for prometheus/otel/sentry = 0 | Dashboard with per-service request rate, error rate and p95; one trace across Ledger→orchestrator→order-service→scheduling |
| G7 | CI | CI runs only the architecture contract; no unit/integration tests | S1 | `.github/workflows/` has 1 file | PR gate runs all suites against Postgres + Redis (+ Kafka for integration) |
| G8 | Resilience | No circuit breaker/bulkhead; retries in orchestrator only (`order_domain.py`, up to about 47s backoff) | S2 | grep for circuit = 0 | Downstream outage does not exhaust orchestrator workers |
| G9 | Security | Shared secret for all internal calls; `routeAuth.ts` compares tokens with `===` | S2 | `routeAuth.ts` | Per-service credentials/mTLS plan; constant-time compare |
| G10 | Security | No rate limiting or security headers on services; CORS only on the agent-orchestrator (single hardcoded origin), none on Node services | S2 | grep | Gateway or middleware in place |
| G11 | Scheduler | No benchmark or KPI record; changeover not in pipeline | S2 | [aps review](aps_engine_architecture_review.md) | Benchmarks in CI with regression thresholds |
| G12 | Agents | No eval datasets or prompt versioning | S2 | grep = 0 | Eval run on each prompt change; thresholds in [validation](validation_and_acceptance_criteria.md) |
| G13 | Operability | Orchestrator and Ledger have no Dockerfile; compose never run | S2 | `project_docker_compose_gap` memory and files | Reproducible start with a documented runbook |
| G14 | Tests | 15 of 18 services with 0 or 1 test file; pre-existing failing tests not triaged | S2 | file counts | Triaged; zero known-red tests |
| G15 | DR | No backup/restore or RPO/RTO defined | S1 | none found | Restore drill passes within RTO |

Items that are **not** gaps (verified good): tenant-scoped identity assertions (HMAC, audience-bound, 60s TTL), DB exclusion constraint against overlapping reservations, hash-bound approvals, scheduler per-plant lock with fencing, idempotency keys with request hash, architecture contract in CI.
