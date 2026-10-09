# Operations Guide — Disruption/Recovery & Promise-Risk Workflow

Phase 17 (Production Readiness & Observability). Scoped to the parts of
this platform that are new or materially hardened in Phases 10–17: the
ORDER_PROMISE / PROMISE_RECOVERY agentic workflow, the approval/execution
pipeline, and the Ledger Promise Risk Inbox. This is not a general
monorepo runbook — `README.md`/`ARCHITECTURE_BASELINE.md` cover the wider
system; `infra/docker-compose.yml` is the intended deployment topology
(not runnable in this dev sandbox — no Docker here, confirmed).

## 1. Local startup

Required running dependencies: Postgres (`DATABASE_URL`), Redis
(`REDIS_URL`, scheduling-service's capacity reservations), Kafka
(disruption/order-update event consumers — optional for manual testing,
required for the automatic Kafka-triggered reschedule path).

```bash
npm install                                   # root — npm workspaces, one lockfile
cd services/order-service && npx tsx src/index.ts       # port 4001
cd services/scheduling-service && npx tsx src/index.ts  # port 4005
cd services/agent-orchestrator && source .venv/bin/activate && uvicorn app.main:app --port 8000
cd frontend && npm run dev                               # port 3000, Ledger UI
```

Every TS service reads `INTERNAL_SERVICE_TOKEN`/`DATABASE_URL`/`REDIS_URL`
from the root `.env` (gitignored, never committed — confirmed via
`.gitignore`'s `.env*` pattern). `agent-orchestrator` additionally needs
`GROQ_API_KEY` for anything that reaches a real LLM call; tests mock the
LLM, so a missing key doesn't block the test suite.

## 2. Health vs. readiness

Every service (via `packages/shared`'s `createApp()`) exposes:
- `GET /health` — liveness only: "is the process up." No credential
  required. Always `{"status":"ok"}` if the process is running at all.
- `GET /health/ready` — dependency readiness, where configured.
  `order-service` and `scheduling-service` check real Postgres
  connectivity (and Redis, for `scheduling-service`); a failed check
  returns `503` with `{"ready": false}`, never a fabricated `200`. A
  service that hasn't opted in returns `{"ready": true, "checked": false}`
  — an honest "nothing was actually verified," not a silent `200` that
  looks the same as a real pass.

Use `/health/ready` for anything deciding whether to route real traffic
to a service; use `/health` only for "should this process be restarted."

## 3. Tracing a promise or recovery workflow across services

Every request carries `x-trace-id` (`packages/shared/src/http.ts` on the
TS side; `app/trace_context.py`'s `ContextVar` on the Python side).
`grep -r "<trace-id>" infra/logs/*.log` (or `docker compose logs`, in a
real deployment) finds every log line from every service for one
specific workflow instance, because every outbound internal call forwards
the same id it received (`manufacturing_services.py`'s
`_internal_headers()`).

A disruption-recovery episode's trace id:
- **Detection → proposal**: scheduling-service mints the id when
  `checkPromiseImpact` detects a breach (`pipeline.ts`) and sends it as
  both `trace_id` in the event body and the `x-trace-id` header to
  `POST /disruptions/evaluate`. Every capability call, simulation call,
  and the resulting `AgentPipelineRun` row's logging during that request
  carries this same id.
- **Approval → execution**: a human clicking Approve is a *separate* HTTP
  request (no inherited trace context from the original detection). As of
  this phase, `resolve_sales_order_approval`/`resolve_reschedule_approval`
  re-anchor tracing on the run's own `run_id` (`set_trace_id(body.run_id)`)
  — stable, already-logged, already the key an operator would search by
  anyway. Before this phase, the approval/execution half of a recovery was
  untraceable by trace id at all (a real, now-closed gap).

`run_id` (== `AgentPipelineRun.id`) is the one identifier that spans the
*whole* saga end to end, including across the detection/approval trace-id
boundary above — when in doubt, search logs and the DB by `run_id`, not
just `x-trace-id`.

## 4. Common failure states and what to do about them

| Symptom | What it means | Where to look |
|---|---|---|
| `GET /sales-orders/promises` item has `riskStatus: UNKNOWN`, `reasonCode: SCHEDULE_MISSING` | No current `ScheduledOperation` rows for this order's production leg | Check whether the production order was ever actually scheduled (`GET /orders/:id`) |
| `reasonCode: SCHEDULE_STALE` | A scheduled operation's window already passed with no `actualEnd` recorded — the schedule data cannot be trusted as evidence | Check the shop-floor/MES completion feed for this operation; this is a data-freshness problem, not necessarily a real delay |
| `workflowStatus: AWAITING_APPROVAL` alongside `riskStatus: BREACHED` | Expected and correct — a pending recovery proposal does not change the real current risk | Review and approve/reject via the existing Pending Decisions / Agent Console flow (Ledger `/pending-decisions`) |
| `status: "DUPLICATE_SKIPPED"` from `/disruptions/evaluate` | A recovery proposal for this production order is already pending — this call was a redundant disruption notification (Kafka redelivery, or two disruption types close together) | No action needed; check the existing pending approval instead of this request |
| `/approvals/reschedule/resolve` returns `409` with `"...already meets the original promise...appears moot"` | The staleness check (Phase 16) found the schedule already restored the promise since this proposal was shown — approving would be a redundant reschedule | Re-evaluate: dismiss the stale proposal, don't force-execute it |
| `/approvals/reschedule/resolve` returns `502` | The real reschedule call to scheduling-service failed (service down, genuine conflict) | The approval stays `APPROVED` (never silently reverted to `PENDING` — that would let a retry bypass the original decision); submit a **fresh** request for a new proposal, don't retry the same `run_id` |

## 5. Investigating an unverified or failed recovery

`workflowStatus: RECOVERY_VERIFIED_FAILED` on an inbox item means the
recovery *executed* (the committing reschedule call succeeded) but
post-execution re-verification (`_evaluate_reschedule_goal_satisfaction`
in `approvals.py`, re-reading the real committed schedule after
execution) found the original promise still unmet. This is never silently
upgraded to "success" — the HTTP call returning `200` is deliberately
treated as a separate fact from the promise being restored.

To investigate: read `AgentPipelineRun.executionResult.goal_satisfaction`
for that `run_id` (`requested_date` vs. `promised_date`, `satisfied`).
This is the authoritative, already-computed answer — no need to
re-derive it manually. If it's missing or `null` for a `RESCHEDULE_PRODUCTION`
run, either `original_promised_date` was never set on the proposal (a
plain chat-driven reschedule, not a promise-recovery one — expected,
not a bug) or the production order became unreadable post-execution
(logged as a warning in `approvals.py`).

## 6. Test commands and required services

| Suite | Command | Requires |
|---|---|---|
| `packages/domain` | `npm test -w @aps/domain` (or `cd packages/domain && npx vitest run`) | nothing external |
| `order-service` | `cd services/order-service && npx vitest run` | real Postgres (`DATABASE_URL`) |
| `scheduling-service` | `cd services/scheduling-service && npx vitest run` | real Postgres + Redis |
| `frontend` | `cd frontend && npx vitest run` | nothing external (API calls are mocked) |
| `agent-orchestrator` | `cd services/agent-orchestrator && pytest app/tests/` | real Postgres; LLM calls are mocked in every test file except a few known-flaky, intentionally-live ones (Groq rate-limit-sensitive — see below) |
| Architecture contract | `node --test architecture/check-contract.test.mjs` (repo root) | nothing external |

**Known flaky tests, not regressions**: a recurring, stable set of
agent-orchestrator tests intermittently fail on Groq rate limits or
test-execution-order sensitivity, unrelated to any specific change —
`test_approval_state.py::test_normal_approval_flow_produces_one_real_sales_order_with_fulfillment`,
`test_entry_router.py`'s subscription/clarification tests,
`test_production_planning_agent.py`'s tests, `test_security.py`'s
`test_mutation_succeeds_for_planner_or_above` variants,
`test_understanding_routing.py::test_reference_resolution_runs_between_understanding_and_context`,
occasionally `test_billing.py::test_billing_agent_full_delivery`. Re-run
to confirm before treating any of these as a real regression.

## 7. Deployment and rollback

This dev environment runs every service directly (`tsx`/`uvicorn`), not
via the Docker topology `infra/docker-compose.yml` describes (Docker is
unavailable here). That compose file remains the source of truth for the
intended real deployment shape (one entry per service, Postgres/Redis/
Kafka/ClickHouse as dependencies).

- **Database backup/restore**: `infra/scripts/backup-postgres.sh [dir]`
  (pg_dump, custom format) / `infra/scripts/restore-postgres.sh <dump> [target-db]`
  (restores into a new database by default — never the live one
  implicitly; an operator must explicitly name the real target to
  overwrite it). Already real, already safe — not new to this phase.
- **Schema migrations**: `packages/domain/prisma/migrations/*` — standard
  Prisma migration history, applied via `npm run db:migrate` (root). No
  destructive migration has been written without an additive/backfill
  path in this codebase's own convention so far; there is no automated
  migration-rollback tooling beyond Prisma's own (restore from the backup
  above is the real rollback path for a bad migration).
- **No infrastructure change, secret rotation, or production deployment
  was made or is proposed by this phase** — out of scope per this
  phase's own constraints, and nothing here requires it.
