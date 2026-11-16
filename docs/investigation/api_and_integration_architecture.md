# API and integration architecture

Reviewed: shared HTTP/error helpers, order-service list endpoint, orchestrator integration clients, ERP adapter interface. Not every endpoint was read.

| Topic | Finding | Evidence |
|---|---|---|
| Style | REST/JSON over HTTP between services; FastAPI routers in orchestrator | |
| Versioning | **None** (no `/v1` prefix) | grep = 0 |
| Validation | Inconsistent: `zod` in 1 file; Pydantic in orchestrator; many TS routes validate by hand | grep |
| Error contract | `DownstreamSyncError` is a typed error; a uniform error envelope across services was not verified | `errors.ts` |
| Pagination | `limit`/`offset` on the promises list; other lists not verified | `order-service/app.ts:403` |
| Auth | Internal token + signed identity (see security doc) | |
| Idempotency | `Idempotency-Key` with request hash for order and production-order creation and scheduling runs | contract E1 |
| Correlation | `x-trace-id` propagated | contract H1 |
| Rate limiting | None | |
| Webhooks | None found | |
| Event schemas | JSON via `kafkajs`, **no schema registry or versioned envelope**; consumers `JSON.parse` blindly | `kafka.ts` |
| Contract tests | None between Ledger/orchestrator/order-service | |
| External ERP | `ERPAdapter` interface with mock and SAP implementations; SAP dry-run flag; `erp-integration` IDoc ingestion | `app/erp/`, `erp-integration` |

## Can services evolve independently?

Partially. They share the Prisma client, so a schema change touches every service at deploy time (a hidden coupling), and there are no consumer-driven contract tests to catch HTTP drift. Independent release is not safe today.

## Recommendations

1. Event envelope `{eventId, type, version, occurredAt, traceId, enterpriseId, payload}` in `packages/shared` (required for inbox dedupe).
2. Uniform error envelope `{code, message, traceId, retryable}`; map `DownstreamSyncError` to it.
3. Introduce `/v1` only at the Ledger/orchestrator/order-service boundary (external-facing and cross-language), not for every internal route.
4. Zod (TS) request validation on all mutating routes; generate OpenAPI from schemas for the three boundary APIs.
5. Consumer-driven contract tests (Pact or a simple schema snapshot) for the orchestrator→order-service and orchestrator→scheduling calls, the most failure-prone cross-language edge.
6. Additive-only schema migrations with expand/contract for anything the shared client reads.
