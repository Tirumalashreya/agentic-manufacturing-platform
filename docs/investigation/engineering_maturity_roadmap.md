# Engineering maturity roadmap and final engineering assessment

## Maturity levels with objective acceptance criteria

### Level 1: Controlled pilot (single site, named users)

| Criterion | Measure |
|---|---|
| No lost or double-applied events | Chaos test: broker killed twice during 1,000 writes → 0 lost, 0 duplicates applied (ADR-001) |
| Single source of truth for delivery/invoice | Reconcile diff = 0 for 7 days (ADR-002) |
| CI gates merges | TS suites + serial pytest + architecture contract green; no known-red tests |
| Backup/restore | Restore drill ≤ 4 h; RPO ≤ 24 h (≤ 15 min preferred) |
| Observability | Request/error/latency per service; one trace across an order; alerts on outbox age, DLQ depth, consumer lag |
| Runbooks | Stuck lock, stuck completion step, broker loss, restore |
| Approvals | Zero unapproved consequential actions across pilot |
| Deployability | All services including orchestrator and Ledger start from containers on a clean host |

### Level 2: Production-ready platform

| Criterion | Measure |
|---|---|
| Concurrency | Parallel reservations/completions/approvals pass race suite (50 parallel; 0 oversell, 0 double completion) |
| Security | Per-service credentials, constant-time compares, rate limits, TLS, secrets manager, dependency scanning in CI, separation of duties on commits |
| Reservation ledger and audit | Every reserved unit traceable (ADR-005) |
| Scheduler | Benchmark table in repo, regression gate in CI; changeover in pipeline if the benchmark shows value |
| Agents | Eval suite in CI; prompt/model versions recorded; allow-lists enforced (ADR-006) |
| Reliability | 99.5% availability measured over 90 days; RPO ≤ 5 min; RTO ≤ 1 h; circuit breakers on orchestrator calls |
| Contract tests | Cross-language boundary tests green |

### Level 3: Enterprise scale

| Criterion | Measure |
|---|---|
| Multi-site and tenant | `siteId` scoping; product master per enterprise; cross-tenant tests all negative |
| Integrations | Versioned APIs and event schemas; backward-compat tests; SAP adapter in production use if required |
| Resilience | Multi-AZ or per-site cell; DR drill passes RTO ≤ 15 min |
| Governance | Audit retention policy, access reviews, change management |
| Optimization | Solver proposer adopted only if the benchmark justifies |

## Final engineering assessment (Part 12.15)

1. **Is the architecture sound?** The core is sound (one DB, one scheduler authority, signed identity, hash-bound approvals, independent schedule validator, contract in CI). The plumbing is not production-grade (events, Excel, observability, CI).
2. **Preserve:** shared Postgres schema; single scheduler; candidate→validate→publish; propose-only agents; idempotency keys and fencing; architecture contract.
3. **Change:** add outbox/inbox/DLQ; make Postgres the only source of truth; add reservation ledger; add product tenancy; add real CI and observability.
4. **Incorrect service boundaries:** none are clearly wrong. The weak spots are *ownership* (ProductionOrder has three writers; Delivery/Invoice live in the orchestrator) and *over-splitting* (optimization pair; thin resource services).
5. **Domains lacking clear ownership:** Delivery, Invoice, credit, returns (orchestrator/Excel); ProductionOrder state transitions; Procurement (PG and Excel).
6. **Where data can become inconsistent:** Excel vs. Postgres; event loss between commit and publish; Redis buckets vs. Postgres reservations after Redis loss; `qtyReserved` counter vs. real reservations; order quantities vs. `actualGoodUnits`.
7. **If each critical service fails:** see [distributed_systems_failure_analysis.md](distributed_systems_failure_analysis.md). Behavior is inferred from code, not tested.
8. **Can the scheduler handle realistic complexity?** Unknown. It has the right feature set for a rule-based finite-capacity scheduler, but no benchmark and no sequence-dependent setup.
9. **Can multiple users operate concurrently safely?** Core write paths have locks, CAS and idempotency; coverage is uneven and there is no parallel-user test. Excel paths are single-host and serialized.
10. **Can agents bypass business rules?** Not by design (typed tools, hash-bound approval, no direct DB writes). Not proven: nine agents unaudited; allow-lists not enforced; the fulfillment and vendor decisions were LLM-made as of Oct 5.
11. **What prevents multiple factories?** Global `Product`, no `siteId`, Excel single-host, shared secret trust model, unmeasured scheduler scale.
12. **Capabilities needed before scaling:** reliable messaging, CI, observability, DR, security hardening, benchmarks, eval harness.
13. **Fix immediately:** CI test gate; outbox/inbox/DLQ; Delivery/Invoice reconciliation; triage red tests; constant-time compares; backups.
14. **Keep simple:** one DB, one scheduler, rule-based dispatch, HTTP commands, current service count, two apps.
15. **Do not build yet:** sourcing/RFQ, new microservices, Kubernetes dependency, event sourcing, LLM scheduling, predictive maintenance, multi-site scheduling optimization.

## Sequencing

Weeks 1 to 2: CI, red-test triage, backups, constant-time compares. Weeks 3 to 6: outbox/inbox/DLQ, reconcile job, observability, Dockerfiles. Weeks 7 to 10: scheduler benchmark, reservation ledger. Then the command center, agent eval, product tenancy.
