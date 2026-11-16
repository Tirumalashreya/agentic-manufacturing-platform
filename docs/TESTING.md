# Testing

## Prerequisites
Node per `.nvmrc`, Python 3.13 (`services/agent-orchestrator/.venv`), PostgreSQL, Redis, Kafka reachable at the URLs in `.env` (see below). Docker is not required.

## Environment variables
| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | all Prisma services, orchestrator | Tests create isolated Enterprise/Site/Plant fixtures and delete them afterwards, but they run against whatever database this points at: use a dev/test DB, never production |
| `REDIS_URL` | scheduling-service | capacity buckets, plant lock |
| `KAFKA_BROKER` | all publishers/consumers | default `localhost:9092` |
| `INTERNAL_SERVICE_TOKEN` | every service and test | fail-closed if unset |
| `GROQ_API_KEY` (orchestrator `.env`) | live-LLM tests only | CI uses a dummy; live-LLM tests are deselected. **Never pass it by grepping `.env`** (`grep GROQ_API_KEY .env \| cut …`): the file holds several key lines, which produces an invalid header and prints every key. Use the dummy for non-LLM runs. |
| `POSTGRES_ID_AUTHORITY` / `POSTGRES_INVOICE_ID_AUTHORITY` | orchestrator | **Off by default; do not set globally.** Tests that need them set them per test (`monkeypatch`), with a faked allocator. |
| `CORS_ALLOWED_ORIGINS` | orchestrator | exact origins, comma-separated; unset = `http://localhost:3000`; empty = none; wildcard refused at startup |

## Commands
```
set -a; . ./.env; set +a
npm run test:architecture && npm run check:architecture
for d in packages/domain services/order-service services/scheduling-service services/mes-integration \
         services/inventory-service services/machine-service services/maintenance-service \
         services/erp-integration frontend; do (cd $d && npx vitest run); done
(cd services/agent-orchestrator && .venv/bin/python -m pytest app/tests -q)   # ONE process, ~13 min
```
Type check: `npx tsc --noEmit -p .` inside each service, `frontend`, `web`.

## Rules
- **Never run two pytest processes at once** against agent-orchestrator: they share `mock_erp.xlsx` and will corrupt it. `conftest.py` snapshots and restores the file around a clean run, but an interrupted/killed run can skip the restore, so back the file up first (`git checkout -- services/agent-orchestrator/mock_erp.xlsx` restores the tracked copy if you have no local edits to it).
- Do not run `packages/domain/_wipe_demo_data.ts` or other `_`-prefixed scripts as part of testing.
- Known baseline failures: `docs/BASELINE.md`.

## CI
`.github/workflows/ci.yml`: typecheck, TS tests (Postgres/Redis/Kafka service containers, migrations applied with `prisma migrate deploy` to an empty database), architecture contract, and orchestrator pytest. **The workflow has been YAML-validated and its commands verified locally but has not yet run on GitHub**: the first run verifies the container wiring.
