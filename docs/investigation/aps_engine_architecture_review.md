# APS engine architecture review

All statements are from reading code. **No benchmark was run**, so nothing here says the scheduler is good or bad in quality. It says what it implements.

## What the engine implements (VERIFIED)

| Capability | Implemented? | Evidence |
|---|---|---|
| Finite capacity | Yes. 15-minute capacity buckets in Redis, seeded from real data | `capacity-engine.ts` (`BUCKET_MINUTES = 15`), `seedNamespaceFromReal` |
| Placement modes | FORWARD, BACKWARD, BOTTLENECK; per-product default | `pipeline.ts`, `Product.defaultSchedulingMode` |
| Dispatch rules | EDD, SPT, LPT, CR, ATCS, PRIORITY_SCORE per work center | `dispatch-rules.ts` |
| Priority score | Customer tier, order value, penalty exposure | `priority-score.ts`, constants in `pipeline.ts` |
| Machine capability and operator skills | Yes | `checkMachineCapability`, `checkOperatorSkills`, `resolveAndAssignOperator` |
| Shift / holiday / factory calendars | Yes | `expandShiftWindows`, `narrowWindowsTo*`, migrations |
| Alternative machines / work centers | Yes | `resolveAlternativeMachine`, `tryAlternativeWorkCenters` |
| Operation precedence, critical path | Yes | `topologicalOrder`, `cpm.ts` |
| Material constraint | Check at placement only | `checkOperationMaterial` |
| Planning time fence (frozen zone) and schedule stability | Yes, 24 h fence; in-progress/done ops protected | `PLANNING_FENCE_HOURS` |
| Rescheduling scopes | SINGLE / AFFECTED / ALL | `resolveScopedOrderIds` |
| Candidate → validate → publish with versioning | Yes. A rejected candidate never goes live | `schedule-validator.ts`, versioning tests |
| What-if / dry run | Yes | `DryRunCtx`, `recovery-whatif` tests |
| Bounded lookahead (13 → 26 weeks) | Yes | `EXTENDED_HORIZON_DAYS` |
| Concurrency control | Per-plant Redis lock with renewal and fencing | `packages/shared/src/redis.ts` |
| Setup time | **Flat, once per operation** (`ceil(proc × qty + setup)`) | `pipeline.ts:662,830,1030` |
| Sequence-dependent changeover | **Not in the pipeline.** `ChangeoverMatrix` model and a TSP routine exist in optimization-service only | `optimization-service/src/tsp.ts` |
| Labor constraints | Skill matching and operator assignment; headcount/shift capacity not verified | |
| Tardiness / multi-objective optimization | **No explicit objective.** Rule-ordered greedy placement | |
| Infeasibility diagnosis | Partial: rejection reasons on `ScheduledOperation` (migration `add_scheduled_operation_rejection_reason`) | |
| Bottleneck identification | BOTTLENECK mode; analysis outputs not verified | |

## The optimization path

`optimization-service` (load balancing, TSP changeover sequencing) calls `optimization-solver` (CP-SAT). The solver model (`main.py:81`) has: interval variable per job on a fixed machine, `AddNoOverlap` per machine, precedence, minimize makespan, `earliestStartMin`, a horizon and a time limit. It has **no calendars, no setup, no due dates or tardiness, no alternative machines, no material, no operators**. Its output is not shown to be re-validated against calendars when used. The pipeline calls it best-effort and swallows failure (`pipeline.ts:1518`), and it is not deployable here. **In practice it is a no-op.**

## Is it enough for realistic factory complexity?

Not determinable. Rule-based finite-capacity scheduling with calendars, alternates and a frozen zone is the standard commercial baseline. The unknowns are scale (the Redis bucket approach at hundreds of orders × many machines), quality versus an optimal bound, and behavior with real changeover structure. These are exactly what a benchmark answers.

## Benchmark design (PROPOSED)

| Item | Design |
|---|---|
| Instances | (a) classic job-shop sets (e.g., Taillard, Fisher-Thompson style; **I did not fetch these**, verify the source and license); (b) synthetic generator with calendars, 2 to 3 alternative machines, due dates, sequence-dependent setup, scaled 10/50/200/500 operations |
| Baselines | EDD, SPT, ATCS, current pipeline, CP-SAT with time limit (offline, full model) |
| Metrics | Feasibility (violations counted by `schedule-validator.ts`), makespan, total and max tardiness, % late orders, machine utilization, schedule stability (% operations moved after a seeded breakdown), runtime p50/p95, Redis/DB calls |
| Gate | Commit results table; CI fails if any metric regresses > 5% vs. baseline |

## Decision rule for a solver change

Adopt CP-SAT (or similar) as a *proposer* only if, on instances resembling pilot data, it improves tardiness or makespan by a margin that matters to planners **and** its output passes the independent validator **and** runtime fits the interactive budget. Otherwise keep the rule engine. The existing candidate→validate→publish flow makes a proposer integration safe.

## Not recommended now

Replacing the engine; MIP; learned dispatching.
