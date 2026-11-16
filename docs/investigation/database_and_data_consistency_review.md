# Database and data consistency review

## Verified strengths

- 59 models, 34 migrations, one dated migration per change (migration discipline is good).
- Postgres **EXCLUDE USING gist** constraint on `ResourceReservation` against overlap (contract F2).
- Enterprise-scoped uniques (`Inventory`, orders by `externalOrderId`), request-hash idempotency table, immutable proposal migration, `ScheduleAuditLog` and `AuditLog`.
- `FOR UPDATE` row locks in order-service transactions (baseline; spot-checked in contract evidence).

## Findings

| # | Finding | Evidence | Risk |
|---|---|---|---|
| 1 | `Product.sku` globally unique, no `enterpriseId` | `schema.prisma:374` | Tenant collisions; blocks multi-enterprise |
| 2 | Stock reservation = counter | `Inventory.qtyReserved`; movement types only RECEIPT/ISSUE | Cannot audit or release per order; concurrent reserve races depend on application locks. Recent commits fixed one export double-reservation race, which confirms the weakness |
| 3 | Quantities are `Float` | `Inventory`, `ProductionOrder.quantity` | Rounding drift on fractional quantities; consider `Decimal` for money and stock |
| 4 | Excel as source for post-sales | tools files | See below |
| 5 | Delivery/Invoice dual-write ids differ | `Delivery.externalDeliveryId` | Joins by string; nullable FK `salesOrderId` |
| 6 | No outbox table | grep | Event/DB divergence |
| 7 | No soft-delete/archival/retention policy found | schema scan | Unbounded growth (`SensorReading`, `MachineEvent`, audit logs) |
| 8 | Backups: none defined | none found | RPO/RTO unknown |
| 9 | Index review not performed | not done | Unknown; do `EXPLAIN` on promise, schedule and inventory queries under load |
| 10 | Redis capacity buckets are a second state store for capacity | `seedNamespaceFromReal`, `initBucket` | Cache/DB divergence after Redis loss; confirm rebuild path (INFERRED to exist via `seedNamespaceFromReal`) |

## Excel to PostgreSQL

| Item | State |
|---|---|
| Source of truth | Excel first for delivery, invoice, credit, returns, consignment, export, service, subscription, project; PG for orders and manufacturing |
| Dual-write | `dual_write_delivery`, invoice equivalent; upsert by external id; retried up to about 47 s; failure returns `postgres_synced=false` |
| Locking | `fcntl.flock` per process-host. **Single host only** |
| Reconciliation | None |
| Identifiers | Excel ids (`DEL0001`, `SO-1005`) vs PG cuid + external ids |
| Recovery | Re-run dual write for a given delivery is possible (upsert), but nothing triggers it |

### Migration strategy (no workflow breakage)

1. **Report-only reconcile job** (Excel vs PG per entity, by external id). No behavior change.
2. Fix diffs found; add missing mappings.
3. Per entity, in order **Delivery → Invoice → Credit/Customer → Returns**: switch the primary write to PG (through order-service), write Excel as a derived mirror for existing readers.
4. Move readers to PG; keep Excel read-only; retire writes.
5. The agents' Excel tools stay behind the `ERPAdapter` interface (`app/erp/`), so SAP or PG adapters can replace the mock without rewriting agents.

## Isolation and concurrency

Unverified per query. Recommendation: default READ COMMITTED with explicit `FOR UPDATE` on reservation, completion and approval paths (already the pattern); add a concurrency test suite with real parallel connections.
