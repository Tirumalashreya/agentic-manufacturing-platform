# Domain model and bounded contexts

Persistence column: PG = PostgreSQL (Prisma), XL = `mock_erp.xlsx`. Events column lists topics seen in `packages/shared/src/topics.ts`/baseline. "?" = not verified.

## Contexts

| Context | Owns | Authoritative service |
|---|---|---|
| Commercial (Ledger) | Customer, SalesOrder, OrderLine, FulfillmentPlan/Line, credit, Delivery, Invoice, returns | order-service (PG) for orders; **orchestrator + Excel** for delivery/invoice/credit/returns |
| Product definition | Product, BOM, Routing, RoutingOperation | routing-service (PG) |
| Planning & scheduling | ScheduledOperation, ResourceReservation, Schedule, ScheduleRun, ChangeoverMatrix | scheduling-service |
| Production execution | ProductionOrder, ProductionCompletionStep, QualityInspection, ProductionException | order-service (create/update), mes-integration (complete), scheduling-service (exceptions, quality) |
| Inventory & materials | Inventory, InventoryMovement | inventory-service |
| Procurement | Vendor, VendorProduct, PurchaseOrder | inventory-service (PG) and Excel procurement tools |
| Resources | Machine, WorkCenter, Operator, Shift, Calendar, Tool, Maintenance | machine/operator/calendar/tool/maintenance services |
| Agent runtime | AgentPipelineRun, AgentStageResult, approvals | agent-orchestrator (direct SQL) |

## Entity table

| Entity | Domain | Persistence | Lifecycle / states | Key invariants | Ambiguity found |
|---|---|---|---|---|---|
| Customer | Commercial | PG; Excel too | create/update | unique per enterprise external id | Written by order-service **and** erp-integration (documented) |
| Product | Product def | PG | n/a | `sku` globally unique | **No enterpriseId** |
| SalesOrder | Commercial | PG (+Excel mirror) | DRAFT→AWAITING_APPROVAL→APPROVED→IN_FULFILLMENT→PARTIALLY_FULFILLED→COMPLETED; ON_HOLD, CANCELLED | `(enterpriseId, externalOrderId)` unique | Two creation sources (documented) |
| OrderLine / FulfillmentPlan / FulfillmentLine | Commercial | PG | line-level fulfilledQuantity, shortfallReason | created in one transaction | Quantity fields exist on lines and on ProductionOrder (`actualGoodUnits`): reconcile rule not documented |
| Inventory | Inventory | PG; Excel too | qtyUnrestricted/Reserved/InTransit | unique `(enterpriseId, productId, location)` | **StockReservation does not exist**; reserved is a counter |
| BOM / Routing | Product def | PG | n/a | op dependencies acyclic (`topologicalOrder`) | |
| WorkCenter / Machine | Resources | PG | status via machine events | | |
| ProductionOrder | Execution | PG | DRAFT→PLANNED→RELEASED→IN_PROGRESS→COMPLETED/CANCELLED | completion claimed once via atomic `status != COMPLETED` update | Created in order-service, updated by mes-integration and scheduling: three writers |
| ScheduledOperation | Planning | PG | planned/in-progress/done/rejected | reservation exclusion constraint prevents overlap | |
| ProductionCompletion | Execution | PG `ProductionCompletionStep` | durable step ledger | idempotent steps, lease fencing | |
| QualityInspection | Execution | PG | PASS/FAIL | predecessor gate at execution | No NCR/disposition |
| Delivery | Commercial | **XL first, PG dual-write** | created→confirmed… | unique `externalDeliveryId` per enterprise | Ids differ (`DEL0001` vs cuid); `salesOrderId` may be null |
| Invoice | Commercial | **XL first, PG dual-write** | | billed on actual good units (commit `ed18f1c`) | Same |
| PurchaseOrder / Vendor | Procurement | PG; Excel too | | | Two procurement stores |

## Findings

- **Duplicate entities**: Customer, Inventory, SalesOrder, PurchaseOrder, Delivery, Invoice each exist in both XL and PG.
- **Conflicting-state risk**: Excel row shows delivered while PG row failed to write (`postgres_synced=false` is reported but not reconciled).
- **Cross-domain transaction problem**: production completion touches ProductionOrder, Inventory (via HTTP), FulfillmentLine (via HTTP) and billing (Excel). This is handled by a durable step ledger and fencing in mes-integration rather than a distributed transaction. That is the right pattern, and it needs failure tests for each step.
- **Aggregates**: SalesOrder (with lines and plan) and ProductionOrder (with operations) are appropriate aggregates. Inventory movements should be append-only with reservations added.
- **Events**: Only 6 domain topics are consumed. Three declared topics have no consumer (`OPERATIONS_EXCEPTION_REPORTED`, `INVENTORY_MOVEMENT_RECORDED`, `QUALITY_INSPECTION_RECORDED`), so downstream views cannot rely on events for them.
