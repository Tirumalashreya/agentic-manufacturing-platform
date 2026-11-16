# Performance and scalability assessment

**No measurements were taken.** This document identifies suspected bottlenecks from the code and specifies the load tests that would settle them. Do not cite any number below as a result.

## Suspected bottlenecks (from code)

| # | Suspect | Why |
|---|---|---|
| P1 | Excel file I/O under `flock` | Whole-workbook open/save with openpyxl on each write; serializes all writers; single host only; cost grows with sheet size |
| P2 | Per-plant scheduling lock | By design one run per plant at a time; concurrent reschedules queue or fail |
| P3 | Redis bucket seeding | `seedNamespaceFromReal` and per-machine `ensureBucketsInitialized`: cost scales with machines × horizon (91 to 182 days × 96 buckets/day) |
| P4 | `pipeline.ts` sequential per-operation DB/Redis calls | Many awaits in a 1,877-line function; runtime likely linear to superlinear in operations |
| P5 | Orchestrator retry backoff (up to about 47 s) | Holds workers when a dependency is slow |
| P6 | Single-partition Kafka topics | One consumer per group processes serially |
| P7 | Frontend polling (5 s `useLiveList`) | Load scales with open tabs × lists |
| P8 | LLM latency and cost | Seconds per call; per-day token limits on Groq per the config comments |

## Load-test design (PROPOSED)

| Scenario | Shape | Measure |
|---|---|---|
| Concurrent order creation | 20 to 100 parallel POST `/sales-orders` with unique and duplicate idempotency keys | p50/p95/p99, error rate, duplicate count (must be 0) |
| Concurrent reservations | N parallel reserves on the same stock | no oversell; lock wait |
| Completion throughput | 50 parallel completions | steps/s; stuck-step count |
| Scheduling | Benchmark instances (see APS review) at 50/200/500 orders; reschedule ALL vs AFFECTED | runtime, Redis ops, memory |
| Event lag | Burst of 10k events | consumer lag, outbox age |
| Excel contention | 10 parallel agent runs writing billing/delivery | wait time, failures |
| UI | 5k-row order table, Gantt with 2k ops | render time, memory |

Tools: k6 or autocannon for HTTP; a seeded data generator shared with the scheduler benchmark; Postgres `pg_stat_statements` and `EXPLAIN (ANALYZE)` on top queries. Run on hardware representative of the pilot host.

## Scalability posture

Vertical scale on one host is the realistic pilot path. Horizontal scale is constrained by: Excel (single host), the plant lock (per-plant, fine), and the shared DB. Nothing here needs sharding.
