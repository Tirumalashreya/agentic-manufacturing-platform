process.env.SERVICE_NAME = "order-service";

import { createApp, registerErrorHandler, logger, publish, TOPICS } from "@aps/shared";
import { prisma, computePriorityScore, type CustomerTier, type Prisma } from "@aps/domain";

// Split out of index.ts (remediation, Phase 1) so vitest+supertest can
// exercise every real route against a real test-only Express instance
// without binding a port — index.ts is now just the process bootstrap
// (app.listen), unchanged in behavior.
export const app = createApp();

const REFERENCE_MAX_ORDER_VALUE = 100_000;
const REFERENCE_MAX_PENALTY_EXPOSURE = 5_000;
const PLANNING_HORIZON_DAYS = 91;

// §11: "Order Service — Production order CRUD, priority scoring, status
// lifecycle — Publishes orders.production.*"

// No service previously exposed Customer creation — every Customer in this
// codebase's history was created via direct Prisma access in ad-hoc scripts.
app.post("/customers", async (req, res) => {
  const { name, tier, slaDays, penaltyPerDay } = req.body;
  const customer = await prisma.customer.create({ data: { name, tier, slaDays, penaltyPerDay } });
  res.status(201).json(customer);
});

// Order-to-production Phase 1: find-by-name lookup so the agent-orchestrator's
// dual-write (mock-ERP customer name is the only stable key it has) can
// reuse an existing real Customer row instead of creating a duplicate one
// on every order.
app.get("/customers", async (req, res) => {
  const { name } = req.query as { name?: string };
  if (!name) {
    res.json([]);
    return;
  }
  const customer = await prisma.customer.findFirst({ where: { name } });
  res.json(customer ? [customer] : []);
});

app.post("/sales-orders", async (req, res) => {
  const {
    customerId, dueDate, value, priority,
    orderNumber, channel, fulfillmentType, status, currency, createdBy, externalOrderId,
  } = req.body;
  const salesOrder = await prisma.salesOrder.create({
    data: {
      customerId, dueDate: new Date(dueDate), value, priority,
      orderNumber, channel, fulfillmentType, status, currency, createdBy, externalOrderId,
    },
  });
  res.status(201).json(salesOrder);
});

// Order-to-production Phase 1: lookup by the agent-orchestrator's own
// mock-ERP sales_order_id (e.g. "SO-1005") — the dual-write's read side,
// since Python only ever knows that id, not this row's real cuid.
app.get("/sales-orders", async (req, res) => {
  const { externalOrderId } = req.query as { externalOrderId?: string };
  if (!externalOrderId) {
    res.json([]);
    return;
  }
  const orders = await prisma.salesOrder.findMany({
    where: { externalOrderId },
    include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
  });
  res.json(orders);
});

// VENDOR is kept accepted (legacy — pre-hardening rows/callers) but is no
// longer emitted by the agent-orchestrator's dual-write, which now writes
// the more specific BUY/DROP_SHIP directly.
const VALID_SOURCE_TYPES = ["STOCK", "PRODUCTION", "VENDOR", "BUY", "DROP_SHIP", "TRANSFER"];

// One order line + its fulfillment plan + fulfillment leg(s), created
// together in one transaction — this is the real, relational counterpart to
// the fulfillment_strategy/from_stock/to_produce split the Fulfillment
// Agent already computes today (see agent-orchestrator's fulfillment_tools.py),
// which until now only ever lived in transient LangGraph state.
//
// Remediation (Phase 1, agreed with the user): validated as a real domain
// invariant, not left to the caller — a SalesOrder's ordered quantity must
// equal the sum of its FulfillmentLine quantities (the HYBRID case,
// STOCK + PRODUCTION = quantity, is just this same check with exactly two
// lines). Checked BEFORE the transaction opens, so an invalid request never
// touches the database at all.
app.post("/sales-orders/:id/fulfillment", async (req, res) => {
  const { productId, productName, quantity, unitPrice, requestedDate, warehouse, strategy, reasoning, lines } = req.body as {
    productId?: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    requestedDate?: string;
    warehouse?: string;
    strategy: string;
    reasoning?: string;
    lines: Array<{
      sourceType: string;
      quantity: number;
      sourceLocation?: string;
      destination?: string;
      vendorId?: string;
      vendorName?: string;
    }>;
  };

  const salesOrder = await prisma.salesOrder.findUnique({ where: { id: req.params.id } });
  if (!salesOrder) {
    res.status(404).json({ error: `No SalesOrder found with id ${req.params.id}` });
    return;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: "At least one fulfillment line is required" });
    return;
  }
  for (const line of lines) {
    if (!VALID_SOURCE_TYPES.includes(line.sourceType)) {
      res.status(400).json({ error: `Invalid sourceType "${line.sourceType}" — must be one of ${VALID_SOURCE_TYPES.join(", ")}` });
      return;
    }
    if (typeof line.quantity !== "number" || line.quantity <= 0) {
      res.status(400).json({ error: `FulfillmentLine quantity must be a positive number, got ${line.quantity}` });
      return;
    }
  }
  const lineTotal = lines.reduce((sum, l) => sum + l.quantity, 0);
  if (lineTotal !== quantity) {
    res.status(400).json({
      error: `Sum of fulfillment line quantities (${lineTotal}) must equal the order line quantity (${quantity})`,
    });
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const orderLine = await tx.orderLine.create({
      data: {
        orderId: req.params.id,
        productId: productId ?? null,
        productName,
        quantity,
        unitPrice,
        requestedDate: requestedDate ? new Date(requestedDate) : null,
        warehouse,
      },
    });
    const fulfillmentPlan = await tx.fulfillmentPlan.create({
      data: { orderLineId: orderLine.id, strategy: strategy as never, reasoning },
    });
    const fulfillmentLines = await Promise.all(
      lines.map((line) =>
        tx.fulfillmentLine.create({
          data: {
            fulfillmentPlanId: fulfillmentPlan.id,
            sourceType: line.sourceType as never,
            quantity: line.quantity,
            sourceLocation: line.sourceLocation,
            destination: line.destination,
            vendorId: line.vendorId,
            vendorName: line.vendorName,
          },
        })
      )
    );
    return { orderLine, fulfillmentPlan, fulfillmentLines };
  });

  res.status(201).json({
    orderLineId: result.orderLine.id,
    fulfillmentPlanId: result.fulfillmentPlan.id,
    fulfillmentLines: result.fulfillmentLines.map((l) => ({ id: l.id, sourceType: l.sourceType })),
  });
});

// Order-to-production Phase 1: the real, persisted OrderLine/FulfillmentPlan/
// FulfillmentLine record for a sales order, keyed by its mock-ERP id —
// mirrors agent-orchestrator's own GET /sales-orders/{id}/fulfillment shape
// one level down (the raw domain rows, not the Python-side response DTO).
app.get("/sales-orders/:id/fulfillment", async (req, res) => {
  const order = await prisma.salesOrder.findUnique({
    where: { id: req.params.id },
    include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
  });
  if (!order) {
    res.status(404).json({ error: `No SalesOrder found with id ${req.params.id}` });
    return;
  }
  res.json(order);
});

const VALID_FULFILLMENT_LINE_STATUSES = [
  "PENDING", "ALLOCATED", "EXECUTION_CREATED", "IN_PROGRESS", "FULFILLED", "CANCELLED", "FAILED", "ON_HOLD",
];

// Fulfillment architecture hardening (agreed with the user): each
// FulfillmentLine progresses independently, but not arbitrarily — an
// explicit allow-list of legal next states, checked before every write.
// FULFILLED/CANCELLED are terminal. FAILED can retry (back to PENDING) or
// be parked (ON_HOLD).
//
// Concurrency hardening: a request whose target status already equals the
// current committed status is a 409 CONFLICT, not a silent no-op success —
// two callers racing for the same transition must not both see 200. This
// endpoint defines no idempotent-retry semantics of its own (no request
// id, no If-Match), so there is no signal here to distinguish "a genuine
// retry of my own already-applied change" from "I lost a race to another
// caller" — treating both as a conflict is the safe default.
const FULFILLMENT_LINE_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ALLOCATED", "EXECUTION_CREATED", "IN_PROGRESS", "CANCELLED", "FAILED", "ON_HOLD"],
  ALLOCATED: ["IN_PROGRESS", "FULFILLED", "CANCELLED", "FAILED", "ON_HOLD"],
  EXECUTION_CREATED: ["IN_PROGRESS", "FULFILLED", "CANCELLED", "FAILED", "ON_HOLD"],
  IN_PROGRESS: ["FULFILLED", "CANCELLED", "FAILED", "ON_HOLD"],
  ON_HOLD: ["PENDING", "ALLOCATED", "EXECUTION_CREATED", "IN_PROGRESS", "CANCELLED", "FAILED"],
  FAILED: ["PENDING", "ON_HOLD"],
  FULFILLED: [],
  CANCELLED: [],
};

// Order-level status is derived from its fulfillment lines, never set
// directly — same "the whole is a function of its parts" principle as the
// quantity invariant below. Precedence matters: a single FAILED/ON_HOLD
// line puts the whole order ON_HOLD even if others are already FULFILLED,
// because that's the actionable signal a planner needs to see first.
function deriveSalesOrderStatus(lineStatuses: string[]): string | null {
  if (lineStatuses.length === 0) return null; // no fulfillment plan yet — don't touch status
  if (lineStatuses.every((s) => s === "CANCELLED")) return "CANCELLED";
  if (lineStatuses.some((s) => s === "FAILED" || s === "ON_HOLD")) return "ON_HOLD";
  if (lineStatuses.every((s) => s === "FULFILLED")) return "COMPLETED";
  if (lineStatuses.some((s) => s === "FULFILLED")) return "PARTIALLY_FULFILLED";
  if (lineStatuses.some((s) => s === "ALLOCATED" || s === "EXECUTION_CREATED" || s === "IN_PROGRESS")) return "IN_FULFILLMENT";
  return "APPROVED"; // every line still PENDING — nothing has started yet
}

// Thrown from inside a locked transaction to abort it with a real ROLLBACK
// (not a normal return, which Prisma would still COMMIT) and carry the
// exact HTTP response to send once the transaction has actually unwound.
class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "API error");
  }
}

// Recomputes and persists the parent SalesOrder's status from every
// FulfillmentLine across every OrderLine it has — called after any
// FulfillmentLine write, inside the same transaction, so the two never
// drift out of sync.
//
// Concurrency hardening: locks the SalesOrder row itself (SELECT ... FOR
// UPDATE, parameterized — never string-interpolated) before reading the
// full FulfillmentLine set. Without this, two concurrent PATCHes to
// DIFFERENT lines of the SAME order could each read a stale line set and
// race to write conflicting derived statuses; the lock serializes the
// recompute per-order so the second one always aggregates over the first
// one's already-committed change. Always acquired after the caller has
// already locked its own FulfillmentLine row, and only ever in that order
// (FulfillmentLine, then SalesOrder) across every code path in this file —
// a consistent lock ordering, so this cannot deadlock against itself.
async function recomputeSalesOrderStatus(tx: Prisma.TransactionClient, salesOrderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${salesOrderId} FOR UPDATE`;
  const lines = await tx.fulfillmentLine.findMany({
    where: { fulfillmentPlan: { orderLine: { orderId: salesOrderId } } },
    select: { status: true },
  });
  const derived = deriveSalesOrderStatus(lines.map((l) => l.status));
  if (derived) {
    await tx.salesOrder.update({ where: { id: salesOrderId }, data: { status: derived as never } });
  }
}

// Order-to-production Phase 1, hardened: lets a fulfillment leg record its
// own lifecycle progress and (for PRODUCTION legs) which real ProductionOrder
// ended up satisfying it — production planning happens as a separate, later
// step in the approval flow, so this doesn't exist at FulfillmentLine-
// creation time.
//
// Concurrency hardening (agreed with the user): the read-validate-write
// sequence below used to read `existing` via a plain findUnique OUTSIDE
// any transaction — two near-simultaneous requests could both read the
// same PENDING row, both validate PENDING -> ALLOCATED as legal, and both
// write, with the second silently clobbering the first (a lost update).
// Now the entire read+validate+write+recompute sequence runs inside one
// transaction, and the very first statement takes a real Postgres row lock
// (SELECT ... FOR UPDATE, parameterized via Prisma's tagged-template
// $queryRaw — never string-interpolated) on this exact FulfillmentLine.
// A second concurrent request targeting the same row blocks on that lock
// until the first transaction commits or rolls back; when it then
// proceeds, its own read sees the FIRST request's already-committed
// result, not the stale pre-race state — so it validates against reality,
// not a snapshot that's already wrong. Validation failures throw ApiError,
// which aborts the transaction with a real ROLLBACK (ProductionOrder
// linkage, executionReference, and status are all touched by the same
// write, so nothing partial is ever left behind either way).
//
// No external HTTP/LLM/Excel calls happen anywhere in this handler, so
// nothing slow ever runs while the row lock is held — the lock's whole
// lifetime is a handful of local Postgres reads and one write.
app.patch("/fulfillment-lines/:id", async (req, res) => {
  const { productionOrderId, executionReference, status, promisedDate } = req.body as {
    productionOrderId?: string;
    executionReference?: string;
    status?: string;
    promisedDate?: string;
  };

  try {
    const line = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "FulfillmentLine" WHERE id = ${req.params.id} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new ApiError(404, { error: `No FulfillmentLine found with id ${req.params.id}` });
      }

      // Safe to read via the normal Prisma API now — the row lock above
      // guarantees this reflects the true current committed state and
      // cannot change under us until this transaction commits.
      const existing = await tx.fulfillmentLine.findUniqueOrThrow({
        where: { id: req.params.id },
        include: { fulfillmentPlan: { include: { orderLine: true } } },
      });

      if (productionOrderId) {
        if (existing.sourceType !== "PRODUCTION") {
          throw new ApiError(400, {
            error: `FulfillmentLine ${existing.id} has sourceType ${existing.sourceType} — only a PRODUCTION line may link a ProductionOrder`,
          });
        }
        if (existing.productionOrderId && existing.productionOrderId !== productionOrderId) {
          throw new ApiError(400, {
            error: `FulfillmentLine ${existing.id} is already linked to ProductionOrder ${existing.productionOrderId} — a fulfillment cannot be reassigned to a different execution document`,
          });
        }
        const productionOrder = await tx.productionOrder.findUnique({ where: { id: productionOrderId } });
        if (!productionOrder) {
          throw new ApiError(404, { error: `No ProductionOrder found with id ${productionOrderId}` });
        }
      }
      if (status) {
        if (!VALID_FULFILLMENT_LINE_STATUSES.includes(status)) {
          throw new ApiError(400, { error: `Invalid status "${status}" — must be one of ${VALID_FULFILLMENT_LINE_STATUSES.join(", ")}` });
        }
        if (status === existing.status) {
          // Two callers racing for the identical transition — the second
          // to reach this point (after waiting on the row lock) is not
          // "still correct," it lost the race. See the file-level comment
          // on FULFILLMENT_LINE_TRANSITIONS for why this isn't idempotent.
          throw new ApiError(409, {
            error: `FulfillmentLine ${existing.id} is already ${existing.status} — this request lost a concurrent race for the same transition`,
          });
        }
        if (!FULFILLMENT_LINE_TRANSITIONS[existing.status]?.includes(status)) {
          throw new ApiError(400, {
            error: `Invalid transition for FulfillmentLine ${existing.id}: ${existing.status} -> ${status}`,
          });
        }
      }

      const updated = await tx.fulfillmentLine.update({
        where: { id: req.params.id },
        data: {
          ...(productionOrderId ? { productionOrder: { connect: { id: productionOrderId } } } : {}),
          ...(executionReference !== undefined ? { executionReference } : {}),
          ...(status ? { status: status as never } : {}),
          // Order Orchestration (Phase 2, agreed with the user): a real date
          // already computed elsewhere in the pipeline (scheduled operation
          // end for MAKE, vendor expected-arrival for BUY/DROP_SHIP, confirmed
          // delivery date for STOCK) — never invented here, just recorded.
          ...(promisedDate !== undefined ? { promisedDate: promisedDate ? new Date(promisedDate) : null } : {}),
        },
      });
      await recomputeSalesOrderStatus(tx, existing.fulfillmentPlan.orderLine.orderId);
      return updated;
    });
    res.json(line);
  } catch (err) {
    if (err instanceof ApiError) {
      res.status(err.status).json(err.body);
      return;
    }
    throw err;
  }
});

app.get("/orders", async (req, res) => {
  const { plantId, status } = req.query as { plantId?: string; status?: string };
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: status as never },
    include: { salesOrder: { include: { customer: true } }, product: true },
    orderBy: { priorityScore: "desc" },
  });
  res.json(orders);
});

app.get("/orders/:id", async (req, res) => {
  const order = await prisma.productionOrder.findUnique({
    where: { id: req.params.id },
    include: { salesOrder: { include: { customer: true } }, product: true, scheduledOperations: true },
  });
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

// §13 step "Order Intake": BOM exploded, routing resolved, priority scored,
// order persisted — the explosion/routing-resolution part is a lookup
// (routing-service owns creating the actual Routing/BOM records; this just
// links an order to an already-defined one), priority scoring happens here.
app.post("/orders", async (req, res) => {
  const { plantId, salesOrderId, productId, routingId, bomId, quantity, manualOverride, metadata } = req.body as {
    plantId: string;
    salesOrderId?: string;
    productId: string;
    routingId?: string;
    bomId?: string;
    quantity: number;
    manualOverride?: number;
    metadata?: Prisma.InputJsonValue;
  };

  let priorityScore = manualOverride ?? 0;
  if (salesOrderId) {
    const salesOrder = await prisma.salesOrder.findUnique({ where: { id: salesOrderId }, include: { customer: true } });
    if (salesOrder) {
      priorityScore = computePriorityScore({
        customerTier: salesOrder.customer.tier as CustomerTier,
        dueDate: salesOrder.dueDate,
        now: new Date(),
        planningHorizonDays: PLANNING_HORIZON_DAYS,
        orderValue: salesOrder.value,
        referenceMaxOrderValue: REFERENCE_MAX_ORDER_VALUE,
        penaltyPerDay: salesOrder.customer.penaltyPerDay,
        slaDays: salesOrder.customer.slaDays,
        referenceMaxPenaltyExposure: REFERENCE_MAX_PENALTY_EXPOSURE,
        manualOverride,
      });
    }
  }

  const order = await prisma.productionOrder.create({
    data: { plantId, salesOrderId, productId, routingId, bomId, quantity, priorityScore, status: "PLANNED", metadata },
  });

  await publish(TOPICS.ORDERS_PRODUCTION_CREATED, { orderId: order.id, plantId, productId, priorityScore });
  logger.info("Production order created", { orderId: order.id, priorityScore });
  res.status(201).json(order);
});

app.patch("/orders/:id", async (req, res) => {
  const { status, quantity, metadata, salesOrderId } = req.body as {
    status?: string;
    quantity?: number;
    metadata?: Prisma.InputJsonValue;
    salesOrderId?: string;
  };
  // Remediation: a ProductionOrder.salesOrderId must point back to a real
  // SalesOrder — same "clean 404 beats a raw FK constraint 500" reasoning
  // as the fulfillment-lines PATCH above.
  if (salesOrderId) {
    const salesOrder = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
    if (!salesOrder) {
      res.status(404).json({ error: `No SalesOrder found with id ${salesOrderId}` });
      return;
    }
  }
  const order = await prisma.productionOrder.update({
    where: { id: req.params.id },
    data: { status: status as never, quantity, metadata, salesOrderId },
  });
  // plantId + quantityChanged let a rescheduling consumer (§14 Order
  // Cancellation / Order Qty Change) act only on genuine disruptions —
  // quantity !== undefined is checked here, at the point where we still
  // know whether THIS request touched quantity, not just its current
  // value, which a routine status-only update (e.g. RELEASED->IN_PROGRESS)
  // would otherwise be indistinguishable from.
  await publish(TOPICS.ORDERS_PRODUCTION_UPDATED, {
    orderId: order.id,
    plantId: order.plantId,
    status: order.status,
    quantityChanged: quantity !== undefined,
  });
  res.json(order);
});

// Hard delete — unlike PATCH .../status=CANCELLED (a soft cancel that keeps
// the order for schedule history), this actually removes the order and
// everything scheduled against it. Torn down in FK-safe order: reservations
// before their scheduled operations (ResourceReservation has no cascade on
// scheduledOperationId), scheduled operations before the order (Prisma's
// own onDelete: Cascade would handle this step alone, but reservations
// would still block it if left in place), then any dependency edges to/from
// this order, then the order itself. The paired SalesOrder is left alone —
// it may not be exclusively this order's (SalesOrder -> ProductionOrder is
// one-to-many in the schema) and deleting it isn't required for a clean
// delete of this order.
app.delete("/orders/:id", async (req, res) => {
  const orderId = req.params.id;
  const scheduledOps = await prisma.scheduledOperation.findMany({ where: { productionOrderId: orderId }, select: { id: true } });
  const opIds = scheduledOps.map((o) => o.id);

  await prisma.resourceReservation.deleteMany({ where: { scheduledOperationId: { in: opIds } } });
  await prisma.scheduledOperation.deleteMany({ where: { id: { in: opIds } } });
  await prisma.productionOrderDependency.deleteMany({ where: { OR: [{ parentId: orderId }, { childId: orderId }] } });
  await prisma.productionOrder.delete({ where: { id: orderId } });

  logger.info("Production order deleted", { orderId, scheduledOpsRemoved: opIds.length });
  res.status(204).end();
});

registerErrorHandler(app);
