# Validation and acceptance criteria

Targets marked *initial* are proposals to be tuned after the first measurement. None have been measured.

## 1. Test layers

| Layer | What | Where |
|---|---|---|
| Unit | Domain math, dispatch rules, validators | per-service tests (exist for scheduling, order, mes, inventory, orchestrator, Ledger) |
| Integration | Service + real Postgres + Redis (+ Kafka) | **missing in CI** |
| Contract | Architecture contract (exists); API schema contracts between Ledger/orchestrator/order-service | contract file exists; API contracts missing |
| Concurrency | Parallel order creation, reservations, completions, double approval | partial (`test_concurrency_locks.py`, audit commits); add DB-level race tests |
| Chaos | Kill broker/Postgres/Redis/service mid-workflow | missing |
| Agent eval | Labeled cases per workflow | missing |
| Scheduler benchmark | Seeded instances | missing |

## 2. Acceptance by area

| Area | Criterion (initial) |
|---|---|
| Events | 0 lost and 0 double-applied events across 1,000 writes with the broker killed and restored twice |
| Data | Reconciliation: 0 unexplained Excel↔Postgres diffs for 7 consecutive days |
| Concurrency | 50 parallel reservations against stock of 10: total reserved ≤ 10; 0 negative stock |
| Idempotency | Same key + same body ×10 → one effect; same key + different body → 409 |
| Approval | Modified proposal after approval request → STALE, never executed (test exists for hash; keep as regression) |
| Scheduler | Feasibility: 0 constraint violations on all benchmark outputs (via `schedule-validator.ts`). Report makespan, total tardiness, utilization, % ops moved after disruption, runtime p50/p95 per instance size. Regression threshold: no metric worse than 5% vs. the recorded baseline |
| Latency | API p95 < 500 ms for reads, < 1 s for writes at 20 concurrent users on pilot hardware. Scheduling run p95 < 10 s for 100 orders (all initial) |
| Agents | Eval set ≥ 50 cases per workflow; factual accuracy vs. deterministic truth ≥ 95%; policy violations = 0; action correctness ≥ 95%; per-run cost and p95 latency reported |
| Security | No unauthenticated mutation route; cross-tenant read/write tests return 403/404; secrets not in repo |
| Ops | Restore from backup in ≤ RTO; trace spans cross all hops of one order |

## 3. Pilot criteria (Level 1)

Single site, named planners. Pass when, over 4 weeks: zero data-loss incidents, zero unapproved consequential actions, every late order has an explained cause, recovery proposals accepted without edit at a rate we record (no target before baseline), and no sev-1 left open.

## 4. "Competitive" evidence

A committed benchmark table; pilot task-time comparison against the customer's current process (not against Oracle, which we cannot measure); chaos-test report. Claims versus Oracle require a side-by-side on the customer's own scenario, which this investigation cannot provide.
