# Target system architecture

The product-level target is in [target_product_architecture.md](target_product_architecture.md). This is the system-level view: boundaries, communication rules and what to consolidate. Guiding rule: **the simplest architecture that safely meets the requirements.**

## Boundary rules

1. **Postgres is the system of record** for every business entity. Excel and Redis are caches or adapters, never authorities.
2. **One writer per aggregate** (table below). Others call its HTTP API; reads may use the shared client but never write.
3. **Commands are synchronous HTTP with idempotency keys. Notifications are asynchronous events through an outbox.** Never rely on an event for correctness of the originating write.
4. **Consumers are idempotent** (inbox table) and poison messages go to a DLQ.
5. **Agents propose; approval service commits** through the same HTTP commands humans use.
6. **Every request carries a signed identity (enterprise, site, role) and a trace id.**

## Single-writer map (target)

| Aggregate | Writer |
|---|---|
| SalesOrder, OrderLine, FulfillmentPlan/Line, Delivery, Invoice, Customer | order-service (Delivery/Invoice move here from orchestrator Excel) |
| ProductionOrder | order-service (create/cancel), mes-integration (complete) via a defined state-transition API |
| Schedule*, ScheduledOperation, ResourceReservation | scheduling-service |
| Inventory, InventoryMovement, StockReservation, PurchaseOrder, Vendor | inventory-service |
| Product, BOM, Routing | routing-service |
| Resources and calendars | their existing services |

## Consolidation candidates (optional; do only if operating cost hurts)

`calendar-service`, `tool-service`, `operator-service` and `machine-service` could become modules of one "resources" service; `optimization-service` and `optimization-solver` could be one deployable. Gain: fewer processes and ports. Risk: churn. **Not a priority.** Keep service count stable while reliability work proceeds.

## Multi-site model

Add `siteId` to identity claims; scope plants, work centers, inventory locations and schedules by site; keep enterprise as the tenant boundary. Per-site plant lock already exists (per-plant). Product master per enterprise (G4). Multi-site scheduling across plants is out of scope until single-site is validated.

## Deployment

Pilot: containers for all services via compose on one host (write the missing Dockerfiles first and **actually run them**). Defer Kubernetes.
