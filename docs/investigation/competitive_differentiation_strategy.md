# Competitive differentiation: realistic opportunities

No claim below is "better than Oracle". Each is a **hypothesis with the evidence required to confirm or kill it**.

| # | Opportunity | Basis today | Evidence needed | Verdict |
|---|---|---|---|---|
| D1 | **Unified order-to-production workspace** (customer order, promise, production plan, machine, material, delivery on one timeline) | Data already in one Postgres schema; two separate apps | Task-time study: users resolve a late order in fewer steps than a reference baseline we define. **No Oracle baseline measured** | Best candidate |
| D2 | **Explainable promise recovery** (engine-generated options, hash-bound approval, replayable) | Verified: what-if engine, dry-run, immutable proposals, audit log | Pilot: percent of recoveries accepted without edit; time to decision | Strong, partially built |
| D3 | **Cross-order impact analysis** (a machine breakdown to affected orders to customers to promise risk) | Verified: breakdown→reschedule consumer, `AFFECTED` scope, promise-impact detection | Demonstrate on seeded breakdown scenario with measured latency | Strong, needs UI |
| D4 | **Schedule quality** | Rule-based engine only | Benchmarks on makespan, tardiness, stability, runtime vs. dispatch baselines and CP-SAT | **Do not claim** until measured |
| D5 | **Lower operating complexity / fast deployment** | Small team; 18 services is not lightweight, though they share one DB | Time-to-first-schedule for a new site | Hypothesis; consolidation may help |
| D6 | **Conversational operations** | Agent console exists | Task completion vs. forms | Low differentiation (Oracle ships many assistants) |
| D7 | **Mobile operator experience** | Absent | Operator trials | Valuable, not unique |

## Honest competitive position

- **Do not compete on breadth.** Oracle's index alone lists around 260 AI entries across 20 or so modules.
- **Compete on a vertical slice**: discrete/make-to-order manufacturers that need order promising tied to finite-capacity schedule recovery.
- Closest functional benchmarks for the APS slice are specialized planners (PlanetTogether, Kinaxis). **Not researched here.** Research before positioning.

## Prerequisites for any of these to be credible

1. Reliability foundation (outbox, consumer dedupe, DLQ, metrics): a "unified" view that shows inconsistent data destroys trust.
2. A scheduler benchmark and a recorded baseline.
3. A real pilot customer to validate D1 and D2. All "value" statements here are unvalidated until then.
