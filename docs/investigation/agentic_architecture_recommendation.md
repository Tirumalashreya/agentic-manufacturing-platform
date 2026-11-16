# Where to use agents, and where not to

Principle (matches `architecture/contract.yaml` B2/C1/C2/C3/D1): **the LLM is never the source of truth for data or feasibility, and never commits a mutation directly.** Everything authoritative is a deterministic service; consequential actions need a human approval bound to the exact proposal.

## 1. Classification

Classes: **D** deterministic, **P** predictive (statistical/ML/optimization), **A** agentic (LLM reasons over tools), **H** hybrid, **HA** human approval required.

| Capability | Class | Why |
|---|---|---|
| Credit validation | D | Pure rule; auditable; money |
| Inventory accounting, stock reservation | D | Ledger integrity; races (see audit commits on double reservation) |
| Order state transitions, approval enforcement, idempotency, audit | D | Invariants |
| BOM/routing validation, quantity and scrap math | D | Arithmetic |
| Machine capacity, scheduling feasibility | D | Must be provable; `pipeline.ts` + `schedule-validator.ts` |
| Schedule generation | D (rules) now; P (optimization) later if benchmarks justify | See APS review |
| Promise-date computation | D | `checkPromiseImpact` |
| Promise risk early warning | P | Slack/lateness statistics; no LLM needed |
| Demand forecast, ETA, delay, shortage, quality defect, machine failure | P | Time-series/classification; LLM is the wrong tool; **needs data volume we may not have** (HYP) |
| Free-text order understanding (PO email, ambiguous request) | A | Genuinely ambiguous input; output goes to a *proposal* validated deterministically |
| Intent classification / capability selection | A, with deterministic fallback | Already built; keep with fixed enum outputs |
| Fulfillment strategy choice (MTS/MTO/BUY/…) | **H**: deterministic rules decide; LLM explains | Baseline reported this as LLM-decided; re-verify and move to rules if still true |
| Vendor selection for shortage | H: deterministic ranking on `VendorProduct` cost/lead time; LLM explains | Real financial commitment |
| Recovery option generation | H: engine produces feasible options via what-if; LLM ranks/explains | Feasibility must come from the engine |
| Cross-domain root-cause narrative | A over deterministic evidence | LLM adds value only as explanation |
| Recovery execution, PO creation, reschedule commit, order creation from documents | HA | Consequential |
| Delay/inventory/quality verdict explanation | A (read-only verdict writers, already built) | Low risk |

## 2. The ten candidate agents: build, defer, or reject

Existing verified agents: intent, capability selector, request understanding, context, fulfillment, promise options, production planning, scenario comparison, inventory, quality, procurement, plus the Ledger sales-channel agents.

| # | Candidate | Decision | Rationale |
|---|---|---|---|
| 1 | Sales Order Intelligence (document → order draft) | **Build next, narrow** | Ambiguous input. Output is a draft that deterministic validation checks and a human approves |
| 2 | Order Promise | Keep | Exists; make rules authoritative |
| 3 | Promise Recovery | Keep | Exists; engine-generated options |
| 4 | Production Planning Intelligence | Keep as explainer | Verdict clamped by deterministic facts (verified pattern) |
| 5 | Scheduling Intelligence | **Reject as agent** | Scheduling is an optimization problem. Add a benchmarked solver and explanations, not an LLM |
| 6 | Inventory Intelligence | Keep read-only | Verdict writer |
| 7 | Procurement Intelligence | Defer | Needs supplier delay data. Rules first |
| 8 | Quality Investigation | Defer | NCR/disposition workflow must exist first |
| 9 | Maintenance Intelligence | Defer | Needs sensor data |
| 10 | Production Shift Operations | **Not an agent**: a deterministic dashboard/workspace first | Fewer clicks beats chat |

## 3. Per-agent contract (apply to every agent we keep)

| Field | Required content |
|---|---|
| Trigger | Named event or user intent; never autonomous loops without a policy |
| Inputs / context | IDs, not blobs; deterministic facts fetched through typed tools |
| Tools | Allow-list per agent; read tools by default |
| Write permissions | **Propose only.** Writes go through the approval service which re-validates the proposal hash and current state (contract D1) |
| Actions needing approval | All writes with money, inventory, or schedule effect |
| Failure/retry | Bounded retries on reads; writes carry idempotency keys; on exhaustion return a deterministic "unable to evaluate", not a guess |
| Audit | Run id, tool calls, inputs and outputs hash, model/prompt version (**prompt version not tracked today**) |
| Metrics | Task success, factual accuracy vs. deterministic ground truth, policy violations (target 0), action correctness, p95 latency, cost per run |

## 4. Must-do before adding any agent

1. Build an **agent evaluation set** (none exists): 50 to 100 labeled cases per workflow with a deterministic ground truth.
2. Add prompt/model versioning to `AgentPipelineRun`.
3. Re-audit the nine unclassified agents named in the Oct 5 baseline (configuration, export, consignment, financial, service, subscription, project, billing, post-sales) for any LLM output that reaches a write without a deterministic check. **Status at HEAD: unchecked.**

## 5. Deliberately not building

Agents for scheduling, accounting, reservations, credit; autonomous execution of procurement or schedule commits; an agent per Oracle assistant; multi-agent "swarm" coordination. The stated multi-agent phase 8 already runs as deterministic composition plus read-only verdict writers, which is the right shape.
