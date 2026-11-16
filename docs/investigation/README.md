# Investigation: Ledger + APS vs. Oracle Fusion SCM, and engineering maturity

Status: **FINDINGS FOR REVIEW. No production code was changed, nothing staged or committed.**
Only files under `docs/investigation/` were added.

## Evidence basis and limits (read first)

| Item | Basis |
|---|---|
| Repo state | HEAD `e65a291` plus the dirty working tree (18 modified files and 3 untracked, left untouched). |
| Method | Static reading of schema, services, contract, CI, tools and tests, plus targeted greps. Counts such as "547 pytest tests" are `def test_` counts and were **not executed** (the memory note on pytest corrupting `mock_erp.xlsx` applies). |
| Not done | **No load tests, no scheduler benchmarks, no live failure injection, no UI walkthrough.** Every performance, scalability and "beats Oracle" statement is therefore a hypothesis or a proposed test, never a result. |
| Oracle evidence | **Only one Oracle page was actually read**: the SCM AI feature index, `docs.oracle.com/.../aiafl/ai-scm.html`. It gives feature name, release (25A to 26D) and type (AI agent / Agentic app / Predictive AI / "Fusion Claw") and says nothing about autonomy or approval behavior. The per-feature readiness pages, the SCM playbooks, the Architecture Center and the other vendors (SAP, Siemens, Kinaxis and so on) were **not read**. Anything about them is labeled `UNVERIFIED (from general knowledge)` and must be checked before it is used in a sales or strategy decision. |
| Prior docs | `ARCHITECTURE_BASELINE.md` is dated Oct 5 and is partly stale. For example, it says `publish()` has no catch, but `publishTracked` now exists. It is used here only as a lead, and every claim reused was re-checked against HEAD or is marked as unchecked. |

## Labels used

`VERIFIED` = seen in source at HEAD. `INFERRED` = follows from verified code but was not run. `UNVERIFIED` = not checked. `PROPOSED` = new work. `HYPOTHESIS` = needs customer or benchmark validation.

## Documents

Commercial / product set (Parts 1 to 11):
1. [oracle_scm_product_reverse_engineering.md](oracle_scm_product_reverse_engineering.md)
2. [oracle_agentic_vs_deterministic_analysis.md](oracle_agentic_vs_deterministic_analysis.md)
3. [current_product_capability_audit.md](current_product_capability_audit.md)
4. [oracle_vs_our_product_comparison.md](oracle_vs_our_product_comparison.md)
5. [agentic_architecture_recommendation.md](agentic_architecture_recommendation.md)
6. [competitive_differentiation_strategy.md](competitive_differentiation_strategy.md)
7. [enterprise_engineering_gap_analysis.md](enterprise_engineering_gap_analysis.md)
8. [target_product_architecture.md](target_product_architecture.md)
9. [product_roadmap.md](product_roadmap.md) (contains the top 10 and the final Q&A)
10. [validation_and_acceptance_criteria.md](validation_and_acceptance_criteria.md)

Architecture set (Part 12):
`system_architecture_current_state.md`, `target_system_architecture.md`, `domain_model_and_bounded_contexts.md`, `distributed_systems_failure_analysis.md`, `database_and_data_consistency_review.md`, `api_and_integration_architecture.md`, `reliability_and_resilience_assessment.md`, `security_architecture_review.md`, `performance_and_scalability_assessment.md`, `aps_engine_architecture_review.md`, `software_engineering_quality_assessment.md`, `frontend_architecture_review.md`, `agentic_systems_engineering_review.md`, `architecture_decision_records/`, `engineering_maturity_roadmap.md` (contains the Part 12.15 answers).

## Headline findings (one screen)

1. The architecture is **sound in its core choices and weak in its plumbing**. The shared Postgres domain, a single authoritative scheduler, HTTP-to-deterministic-tool agents, signed identity assertions and an enforced architecture contract are all good. There is **no outbox, no inbox or consumer dedupe, no dead-letter handling, no circuit breaker, no metrics or tracing, and no CI beyond the architecture contract.**
2. **Excel (`mock_erp.xlsx`) is still a source of truth** for much of the post-sales domain, with Postgres dual-writes for Delivery and Invoice. Atomicity is explicitly not claimed. This is the largest data-consistency risk.
3. **Multi-factory and multi-tenant is blocked**: `Product` has no `enterpriseId` and `sku` is globally unique. Stock reservation is a single counter, `Inventory.qtyReserved`, with no reservation ledger.
4. **The scheduler is a real finite-capacity, rule-based engine** (dispatch rules, shifts, holidays, alternative work centers, a planning fence, a plant lock). It is **not** a constraint optimizer. Sequence-dependent changeover is not used in the core pipeline. The CP-SAT path models only machine no-overlap, precedence and makespan, and is currently undeployable here. No benchmark exists, so no superiority claim is possible.
5. Oracle's catalogue is mostly **assistive agents plus command-center workspaces**. We cannot verify from the index page how autonomous they are. Our realistic edge is **order-to-production coherence in one workspace with deterministic promise math and explainable recovery**. That is a hypothesis to validate, not a finding.
