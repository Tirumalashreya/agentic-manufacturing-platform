# Software engineering quality assessment

## Strengths

- Comments explain *why* and record real bugs found live (valuable institutional memory).
- Disciplined staged hardening (idempotency, fencing, CAS, independent validator, architecture contract with self-tests).
- Orchestrator: about 547 test functions in 61 files; order-service about 99; scheduling about 35 across 7 files; Ledger 47.
- Migrations are small, dated and named.
- Typed languages for services (TypeScript) and Pydantic schemas.

## Weaknesses

| # | Finding | Evidence | Impact |
|---|---|---|---|
| Q1 | CI runs only the architecture contract | `.github/workflows/` | Regressions undetected |
| Q2 | 15 of 18 services have 0 to 1 test files | file counts | Unsafe change |
| Q3 | Test run is hazardous: parallel pytest processes corrupt the shared `mock_erp.xlsx` (project memory) | | Flaky, unscalable tests |
| Q4 | Very large files: `graph.py` 3,322 lines, `pipeline.ts` 1,877, `scheduling-service/index.ts` 1,195 | wc | Hard to modify safely; needs extraction along natural seams (placement, validation, publish, consumers) |
| Q5 | Pipeline duplicates the duration computation in 3 places (`pipeline.ts:662,830,1030`) | grep | Divergence risk when changeover is added |
| Q6 | 17 pre-existing orchestrator test failures (Oct 5), status at HEAD unknown | baseline | Red suite hides new breakage |
| Q7 | Scratch scripts committed in service package (`scratch-verify*.ts`) | order-service dir | Hygiene |
| Q8 | No lint/type-check/static-analysis gate; no dependency scanning | | |
| Q9 | Many docs at repo root (`PLAN.md`, `SESSION_SUMMARY.md`, `ARCHITECTURE_BASELINE.md`, PDFs) with stale content | | Documentation drift |
| Q10 | No code-review requirement visible (no CODEOWNERS/branch protection files) | | |
| Q11 | Modified, uncommitted working tree (18 files) at investigation time | git status | Unreleased audit fixes |

## Where modification is dangerous

1. `pipeline.ts` (placement, lock, validation, publish in one module).
2. `graph.py` (routing, state, tool dispatch).
3. Anything touching Excel files (shared global state).

## Recommendations (ordered)

1. CI: install deps, start Postgres/Redis service containers, run TS suites, run pytest **serially** with a per-run copy of the workbook.
2. Triage and fix or quarantine the red tests.
3. Add `tsc --noEmit`, ESLint, ruff, and dependency audit to CI.
4. Extract `pipeline.ts` helpers (duration, placement) before adding changeover.
5. Add contract tests at the cross-language edges.
6. Move stale root docs to `docs/archive/` with a banner or refresh them.
