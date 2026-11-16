# Reliability and resilience assessment

## Current state (VERIFIED unless noted)

| Area | State |
|---|---|
| Health | `/health` in 8 files; readiness in 2; all other services lack readiness |
| Logging | Shared logger writing into `infra/logs` (file based) |
| Tracing | `x-trace-id` / run id correlation across HTTP; no tracing backend |
| Metrics, alerts, SLOs | None |
| Failure isolation | None formal (no breakers or bulkheads); optimizer failure is isolated by try/catch |
| Deployment | Never run in containers here; no Dockerfile for orchestrator and Ledger |
| Backup / DR | None defined |

## Realistic targets

Do not claim enterprise availability for a single-server pilot.

| | Pilot (single site, one host) | Production (HA) | Enterprise (multi-site) |
|---|---|---|---|
| Availability objective | 99% during shifts (about 7 h/month downtime tolerated), planned maintenance outside shifts | 99.5% | 99.9% |
| RPO | ≤ 15 min (WAL archiving) or 24 h nightly dump at minimum | ≤ 5 min | ≤ 1 min, per-region replicas |
| RTO | ≤ 4 h (documented restore) | ≤ 1 h | ≤ 15 min |
| Topology | Postgres + Redis + Kafka + services on one machine; **single points of failure acknowledged** | Managed Postgres with standby; Redis with persistence; Kafka 3 brokers or replace with outbox-polling | Multi-AZ, per-site cells |
| Error budget | Tracked, informational | Enforced for releases | Enforced |

## Degradation behavior to design for

| Dependency down | Desired behavior |
|---|---|
| Kafka | Writes succeed; outbox accumulates; UI shows "sync delayed" |
| Redis | Scheduler refuses to run (fail closed), rebuilds buckets from Postgres on recovery |
| Optimizer | Core schedule proceeds (already so) |
| LLM provider | Agents return "unable to evaluate"; deterministic screens still work |
| Excel file lock | Bounded wait then explicit error; no silent loss |

## Work items

Uniform `/health` + `/ready` (DB, Redis, Kafka checks); metrics endpoint; alerts on consumer lag, outbox age, DLQ depth, schedule-run failures, approval STALE rate; runbooks (restore, broker loss, stuck lock, stuck completion step); quarterly restore drill.
