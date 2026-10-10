process.env.SERVICE_NAME = "order-service";

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { createApp, registerErrorHandler, logger, publishTracked, TOPICS, requireIdentity } from "@aps/shared";
import { prisma, computePriorityScore, type CustomerTier, type Prisma, type PromiseRiskStatus } from "@aps/domain";
import { getPromiseInbox } from "./promise-inbox";

// Split out of index.ts (remediation, Phase 1) so vitest+supertest can
// exercise every real route against a real test-only Express instance
// without binding a port — index.ts is now just the process bootstrap
// (app.listen), unchanged in behavior.
//
// Phase 17 — a real readiness check: this service is nothing without
// Postgres (every route reads/writes through @aps/domain's prisma), so
// /health/ready here means "can I actually reach it," not just "is the
// process up" (that's still what plain /health answers).
export const app = createApp({ readinessCheck: () => prisma.$queryRaw`SELECT 1`.then(() => true) });

// Stage 02 (Tenant Isolation + Service Identity): mounted AFTER
// createApp()'s existing requireServiceToken (the service-to-service trust
// boundary is unchanged) and BEFORE every route below — every one of this
// service's real endpoints owns tenant-scoped data (Customer, SalesOrder,
// OrderLine/FulfillmentPlan/FulfillmentLine, ProductionOrder), so there is
// no route here that should be reachable without a verified enterprise
// scope. req.identity.enterpriseId is the ONLY source of truth for tenant
// scoping below — req.body/req.query enterpriseId-shaped fields are never
// read or trusted.
app.use(requireIdentity("aps-internal"));

const REFERENCE_MAX_ORDER_VALUE = 100_000;
const REFERENCE_MAX_PENALTY_EXPOSURE = 5_000;
const PLANNING_HORIZON_DAYS = 91;

// VENDOR is kept accepted (legacy — pre-hardening rows/callers) but is no
// longer emitted by the agent-orchestrator's dual-write, which now writes
// the more specific BUY/DROP_SHIP directly. Moved up from its original
// position (just above the old /sales-orders/:id/fulfillment handler) so
// Stage 03's new one-shot POST /sales-orders path can also use it.
const VALID_SOURCE_TYPES = ["STOCK", "PRODUCTION", "VENDOR", "BUY", "DROP_SHIP", "TRANSFER"];

type FulfillmentLineInput = {
  sourceType: string;
  quantity: number;
  sourceLocation?: string;
  destination?: string;
  vendorId?: string;
  vendorName?: string;
};

// Stage 03 (One True Order → Fulfillment → Production Loop), Part B/H: the
// same real domain invariant POST /sales-orders/:id/fulfillment already
// enforced, extracted so the new atomic one-shot path below can share it
// instead of duplicating (and risking drifting from) the same rule.
// Returns null when valid, or the {status, body} to respond with when not.
function validateFulfillmentLines(
  lines: unknown,
  quantity: number
): { status: number; body: Record<string, unknown> } | null {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { status: 400, body: { error: "At least one fulfillment line is required" } };
  }
  for (const line of lines as FulfillmentLineInput[]) {
    if (!VALID_SOURCE_TYPES.includes(line.sourceType)) {
      return { status: 400, body: { error: `Invalid sourceType "${line.sourceType}" — must be one of ${VALID_SOURCE_TYPES.join(", ")}` } };
    }
    if (typeof line.quantity !== "number" || line.quantity <= 0) {
      return { status: 400, body: { error: `FulfillmentLine quantity must be a positive number, got ${line.quantity}` } };
    }
  }
  const lineTotal = (lines as FulfillmentLineInput[]).reduce((sum, l) => sum + l.quantity, 0);
  if (lineTotal !== quantity) {
    return {
      status: 400,
      body: { error: `Sum of fulfillment line quantities (${lineTotal}) must equal the order line quantity (${quantity})` },
    };
  }
  return null;
}

// Stage 03 Part E: real REQUEST idempotency (see IdempotencyKey's own
// schema comment for why this is distinct from business-key uniqueness).
// Deliberately opt-in — a caller that sends no Idempotency-Key header
// gets exactly today's behavior, so this can never break an existing
// caller that doesn't know about it yet.
//
// Claims the key BEFORE running the real operation (a placeholder row,
// statusCode 0 = "claimed, not yet resolved") — this is what actually
// prevents two concurrent requests with the same key from both executing
// and creating two real orders; the unique index on
// (enterpriseId, key, operation) is the real mutex, not just bookkeeping.
// A second concurrent request sees the claim fail with P2002, and either
// replays the first request's real result (if it already finished with
// the SAME request body — see requestHash below) or gets a 409 (if the
// first request is still in flight, or if the body genuinely differs) —
// it never re-runs `run` itself.
const IDEMPOTENCY_HEADER = "idempotency-key";

// Stage 03C correctness fix: a stable hash of the request body, so a
// replayed key can be told apart from a key reused for a genuinely
// different request (a caller bug, or a forged replay). Object key order
// is not guaranteed to be stable across two logically-identical calls
// (e.g. constructed by different code paths), so keys are sorted
// recursively before hashing — two requests with the same fields in a
// different order must hash identically.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// Stage 07 (Business Audit Trail) — shared by both SalesOrder creation
// branches below (with and without an inline fulfillment plan): the real
// SalesOrder write above already committed, so a failure logging this
// secondary row must never be reported as the creation having failed.
// req.traceId (packages/shared/src/http.ts) ties this row back to
// whichever workflow/run caused it, without this route needing to know
// anything about agent-orchestrator's own run_id.
async function writeSalesOrderAuditLog(req: Request, entityId: string, enterpriseId: string, after: Prisma.InputJsonValue): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { entityType: "SalesOrder", entityId, action: "CREATED", actorId: req.identity?.sub, enterpriseId, traceId: req.traceId, after },
    });
  } catch (error) {
    logger.warn("Failed to write AuditLog row for SalesOrder creation", { salesOrderId: entityId, error: String(error) });
  }
}

async function withIdempotency(
  req: Request,
  res: Response,
  operation: string,
  run: () => Promise<{ status: number; body: unknown }>
): Promise<void> {
  const key = req.header(IDEMPOTENCY_HEADER);
  if (!key) {
    const { status, body } = await run();
    res.status(status).json(body);
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;
  const requestHash = hashRequestBody(req.body);

  try {
    await prisma.idempotencyKey.create({
      data: { enterpriseId, key, operation, requestHash, resultJson: {}, statusCode: 0 },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { enterpriseId_key_operation: { enterpriseId, key, operation } },
      });
      if (existing && existing.requestHash !== requestHash) {
        // Same key, different request — never silently replay another
        // request's result for this one.
        res.status(409).json({ error: "This Idempotency-Key was already used for a different request" });
        return;
      }
      if (existing && existing.statusCode !== 0) {
        res.status(existing.statusCode).json(existing.resultJson as object);
        return;
      }
      res.status(409).json({ error: "A request with this Idempotency-Key is already in progress" });
      return;
    }
    throw err;
  }

  // Stage 03C correctness fix: a failed (non-2xx) or throwing attempt
  // must not be cached as this key's permanent answer — the claim is
  // released so a genuine retry with the same key (after the caller
  // fixes whatever was wrong, or once a transient failure passes) gets a
  // real second attempt instead of being frozen onto the first failure.
  let outcome: { status: number; body: unknown };
  try {
    outcome = await run();
  } catch (err) {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId, key, operation } });
    throw err;
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId, key, operation } });
    res.status(outcome.status).json(outcome.body);
    return;
  }

  await prisma.idempotencyKey.update({
    where: { enterpriseId_key_operation: { enterpriseId, key, operation } },
    data: { resultJson: outcome.body as Prisma.InputJsonValue, statusCode: outcome.status },
  });
  res.status(outcome.status).json(outcome.body);
}

// §11: "Order Service — Production order CRUD, priority scoring, status
// lifecycle — Publishes orders.production.*"

// No service previously exposed Customer creation — every Customer in this
// codebase's history was created via direct Prisma access in ad-hoc scripts.
//
// Stage 02 (Tenant Isolation): enterpriseId comes ONLY from req.identity —
// a body-supplied enterpriseId (if any were sent) is never read.
app.post("/customers", async (req, res) => {
  const { name, tier, slaDays, penaltyPerDay } = req.body;
  const customer = await prisma.customer.create({
    data: { name, tier, slaDays, penaltyPerDay, enterpriseId: req.identity!.enterpriseId },
  });
  res.status(201).json(customer);
});

// Order-to-production Phase 1: find-by-name lookup so the agent-orchestrator's
// dual-write (mock-ERP customer name is the only stable key it has) can
// reuse an existing real Customer row instead of creating a duplicate one
// on every order.
//
// Stage 02: scoped by the caller's own enterprise — without this, any
// caller could probe for (and read) another enterprise's Customer by name.
app.get("/customers", async (req, res) => {
  const { name } = req.query as { name?: string };
  if (!name) {
    res.json([]);
    return;
  }
  const customer = await prisma.customer.findFirst({ where: { name, enterpriseId: req.identity!.enterpriseId } });
  res.json(customer ? [customer] : []);
});

// Stage 02: customerId is cross-checked against the caller's own
// enterprise before the SalesOrder is created — a caller can't create an
// order against another enterprise's Customer merely by knowing its id.
//
// Stage 03 (One True Order → Fulfillment → Production Loop), Part A/H:
// `lines` is new and optional. Omitting it preserves today's exact
// SalesOrder-only behavior (every existing caller — the agent-orchestrator
// dual-write's first call, erp-integration, setup-import.ts — keeps
// working unchanged). Providing it creates SalesOrder + OrderLine +
// FulfillmentPlan + FulfillmentLine(s) in ONE transaction instead of
// requiring a separate POST /sales-orders/:id/fulfillment afterward —
// this is the canonical atomic path Stage 03's plan identified as
// missing (the two existing endpoints are two separate transactions with
// no link between them, so a crash between them left a permanently
// fulfillment-less SalesOrder). Also accepts an optional Idempotency-Key
// header on this path (see withIdempotency) — a retried request with the
// same key returns the original order instead of creating a second one.
app.post("/sales-orders", async (req, res) => {
  const {
    customerId, dueDate, value, priority,
    orderNumber, channel, fulfillmentType, status, currency, createdBy, externalOrderId,
    productId, productName, quantity, unitPrice, requestedDate, warehouse, strategy, reasoning, lines,
  } = req.body as {
    customerId: string;
    dueDate: string;
    value?: number;
    priority?: number;
    orderNumber?: string;
    channel?: string;
    fulfillmentType?: string;
    status?: string;
    currency?: string;
    createdBy?: string;
    externalOrderId?: string;
    productId?: string;
    productName?: string;
    quantity?: number;
    unitPrice?: number;
    requestedDate?: string;
    warehouse?: string;
    strategy?: string;
    reasoning?: string;
    lines?: FulfillmentLineInput[];
  };
  const enterpriseId = req.identity!.enterpriseId;
  const customer = await prisma.customer.findFirst({ where: { id: customerId, enterpriseId } });
  if (!customer) {
    res.status(404).json({ error: `No Customer found with id ${customerId}` });
    return;
  }

  const salesOrderData: Prisma.SalesOrderUncheckedCreateInput = {
    customerId, dueDate: new Date(dueDate), value, priority,
    orderNumber, channel, fulfillmentType: fulfillmentType as never, status: status as never, currency, createdBy, externalOrderId,
    enterpriseId,
  };

  if (!lines) {
    // Unchanged existing behavior — no fulfillment plan requested.
    const salesOrder = await prisma.salesOrder.create({ data: salesOrderData });
    await writeSalesOrderAuditLog(req, salesOrder.id, enterpriseId, { externalOrderId: salesOrder.externalOrderId, status: salesOrder.status });
    res.status(201).json(salesOrder);
    return;
  }

  await withIdempotency(req, res, "create_sales_order_with_fulfillment", async () => {
    const validationError = validateFulfillmentLines(lines, quantity ?? 0);
    if (validationError) return validationError;

    const result = await prisma.$transaction(async (tx) => {
      const salesOrder = await tx.salesOrder.create({ data: salesOrderData });
      const orderLine = await tx.orderLine.create({
        data: {
          orderId: salesOrder.id,
          productId: productId ?? null,
          productName: productName ?? "",
          quantity: quantity ?? 0,
          unitPrice: unitPrice ?? 0,
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
      return { salesOrder, orderLine, fulfillmentPlan, fulfillmentLines };
    });

    await writeSalesOrderAuditLog(req, result.salesOrder.id, enterpriseId, {
      externalOrderId: result.salesOrder.externalOrderId,
      status: result.salesOrder.status,
      strategy,
    });

    return {
      status: 201,
      body: {
        ...result.salesOrder,
        orderLineId: result.orderLine.id,
        fulfillmentPlanId: result.fulfillmentPlan.id,
        fulfillmentLines: result.fulfillmentLines.map((l) => ({ id: l.id, sourceType: l.sourceType })),
      },
    };
  });
});

// Order-to-production Phase 1: lookup by the agent-orchestrator's own
// mock-ERP sales_order_id (e.g. "SO-1005") — the dual-write's read side,
// since Python only ever knows that id, not this row's real cuid.
//
// Stage 02: scoped by the caller's own enterprise.
app.get("/sales-orders", async (req, res) => {
  const { externalOrderId } = req.query as { externalOrderId?: string };
  if (!externalOrderId) {
    res.json([]);
    return;
  }
  const orders = await prisma.salesOrder.findMany({
    where: { externalOrderId, enterpriseId: req.identity!.enterpriseId },
    include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
  });
  res.json(orders);
});

// Phase 14 (Promise Risk & Decision Inbox): the one new aggregation
// endpoint — read-only, no write/approval/execution anywhere in this
// path. Scoped by req.identity.enterpriseId like every other route here;
// classification itself (classifyPromiseRisk, @aps/domain) is purely
// deterministic and never sees a client-supplied value. See
// src/promise-inbox.ts for the real aggregation logic.
const VALID_PROMISE_RISK_STATUSES: PromiseRiskStatus[] = ["BREACHED", "AT_RISK", "SAFE", "UNKNOWN"];
app.get("/sales-orders/promises", async (req, res) => {
  const { limit, offset, search, riskStatus, pendingApprovalOnly } = req.query as {
    limit?: string;
    offset?: string;
    search?: string;
    riskStatus?: string;
    pendingApprovalOnly?: string;
  };

  const parsedRiskStatus = riskStatus
    ? riskStatus
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s): s is PromiseRiskStatus => VALID_PROMISE_RISK_STATUSES.includes(s as PromiseRiskStatus))
    : undefined;

  const result = await getPromiseInbox(req.identity!.enterpriseId, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
    search,
    riskStatus: parsedRiskStatus,
    pendingApprovalOnly: pendingApprovalOnly === "true",
  });
  res.json(result);
});

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

  // Stage 02: scoped by enterprise — a SalesOrder that belongs to another
  // enterprise is reported identically to one that doesn't exist at all.
  const salesOrder = await prisma.salesOrder.findFirst({ where: { id: req.params.id, enterpriseId: req.identity!.enterpriseId } });
  if (!salesOrder) {
    res.status(404).json({ error: `No SalesOrder found with id ${req.params.id}` });
    return;
  }
  // Stage 03: now the shared helper also used by the new atomic
  // POST /sales-orders path — same rule, one place.
  const validationError = validateFulfillmentLines(lines, quantity);
  if (validationError) {
    res.status(validationError.status).json(validationError.body);
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
  // Stage 02: scoped by enterprise, same reasoning as the POST above.
  const order = await prisma.salesOrder.findFirst({
    where: { id: req.params.id, enterpriseId: req.identity!.enterpriseId },
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
  const { productionOrderId, executionReference, status, promisedDate, reason, fulfilledQuantity, shortfallReason } = req.body as {
    productionOrderId?: string;
    executionReference?: string;
    status?: string;
    promisedDate?: string;
    reason?: string;
    // Scrap-aware completion: the real accepted quantity this leg actually
    // produced, set once at production completion — deliberately NOT a
    // status transition (see this field's schema comment: `quantity`
    // stays the original demand, `status` here is left untouched by this
    // write so retrying it is a plain idempotent field overwrite, not
    // subject to the status-transition race-detection 409 below).
    fulfilledQuantity?: number;
    shortfallReason?: string;
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
        include: { fulfillmentPlan: { include: { orderLine: { include: { order: true } } } } },
      });

      // Stage 02: the row lock above is unchanged — this is purely an
      // authorization check on data already read under it. A FulfillmentLine
      // belonging to another enterprise is reported identically to one
      // that doesn't exist, same convention as every other lookup in this
      // file.
      if (existing.fulfillmentPlan.orderLine.order.enterpriseId !== req.identity!.enterpriseId) {
        throw new ApiError(404, { error: `No FulfillmentLine found with id ${req.params.id}` });
      }

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
        // Stage 02: a PRODUCTION line can only ever be linked to a
        // ProductionOrder in the SAME enterprise.
        const productionOrder = await tx.productionOrder.findFirst({
          where: { id: productionOrderId, enterpriseId: req.identity!.enterpriseId },
        });
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

      // Exceptions/Holds (agreed with the user): an explicit reason is
      // stored verbatim (the real deterministic string the caller already
      // computed). Moving OUT of a problem state without naming a new
      // reason clears the old one automatically — a stale "why" from a
      // resolved problem is worse than none, it looks like the problem is
      // still live.
      const PROBLEM_STATUSES = ["FAILED", "ON_HOLD", "CANCELLED"];
      const nextReason =
        reason !== undefined ? reason : status && !PROBLEM_STATUSES.includes(status) ? null : undefined;

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
          ...(nextReason !== undefined ? { reason: nextReason } : {}),
          ...(fulfilledQuantity !== undefined ? { fulfilledQuantity } : {}),
          ...(shortfallReason !== undefined ? { shortfallReason } : {}),
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

// Stage 02: scoped by the caller's own enterprise regardless of what
// plantId/status are requested — a plantId belonging to another
// enterprise simply yields an empty result, never another tenant's rows.
app.get("/orders", async (req, res) => {
  const { plantId, status } = req.query as { plantId?: string; status?: string };
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: status as never, enterpriseId: req.identity!.enterpriseId },
    include: { salesOrder: { include: { customer: true } }, product: true },
    orderBy: { priorityScore: "desc" },
  });
  res.json(orders);
});

app.get("/orders/:id", async (req, res) => {
  // Stage 02: scoped by enterprise — another tenant's ProductionOrder id
  // is reported identically to one that doesn't exist.
  const order = await prisma.productionOrder.findFirst({
    where: { id: req.params.id, enterpriseId: req.identity!.enterpriseId },
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
  // Stage 03C Part B: a timeout/retry of this call (the agent-orchestrator's
  // production-preview planning call, relayed through APS Platform's
  // apsAgent.ts) must not create two ProductionOrder rows for the same
  // logical preview. Reuses the exact same claim-first IdempotencyKey
  // mechanism as POST /sales-orders — an absent header leaves every
  // existing caller's behavior byte-for-byte unchanged.
  await withIdempotency(req, res, "create_production_order", async () => {
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

    // Stage 02: plantId is verified to belong to the caller's own enterprise
    // BEFORE anything is created — a client can't place a ProductionOrder
    // against a plant it doesn't actually have access to merely by knowing
    // its id. enterpriseId on the new row is always taken from this already-
    // verified identity, never derived a second, independently-trusted way.
    const plant = await prisma.plant.findFirst({ where: { id: plantId, site: { enterpriseId: req.identity!.enterpriseId } } });
    if (!plant) {
      return { status: 404, body: { error: `No Plant found with id ${plantId}` } };
    }

    let priorityScore = manualOverride ?? 0;
    if (salesOrderId) {
      // Stage 02: scoped by enterprise — a SalesOrder from another
      // enterprise is treated as not found, same as everywhere else, rather
      // than silently skipping the priority computation.
      const salesOrder = await prisma.salesOrder.findFirst({
        where: { id: salesOrderId, enterpriseId: req.identity!.enterpriseId },
        include: { customer: true },
      });
      if (!salesOrder) {
        return { status: 404, body: { error: `No SalesOrder found with id ${salesOrderId}` } };
      }
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

    const order = await prisma.productionOrder.create({
      data: {
        plantId, salesOrderId, productId, routingId, bomId, quantity, priorityScore, status: "PLANNED", metadata,
        enterpriseId: req.identity!.enterpriseId,
      },
    });
    logger.info("Production order created", { orderId: order.id, priorityScore });

    // Stage 01 (Fail Loud, Fail Closed): the ProductionOrder above already
    // committed — a publish failure here must never turn into an HTTP 500,
    // which would tell the caller the creation itself failed and risk a
    // retry that creates a duplicate order. Logged in full, and surfaced to
    // the caller as a visible warning on an otherwise-normal 201, not
    // swallowed and not misrepresented as a failure.
    const syncError = await publishTracked(
      TOPICS.ORDERS_PRODUCTION_CREATED,
      { orderId: order.id, plantId, productId, priorityScore },
      { operation: "POST /orders", entityId: order.id }
    );
    if (syncError) {
      logger.error("Downstream sync failed after commit", {
        operation: syncError.operation,
        target: syncError.target,
        entityId: syncError.entityId,
        cause: String(syncError.cause),
      });
      return { status: 201, body: { ...order, syncWarning: syncError.message } };
    }
    return { status: 201, body: order };
  });
});

app.patch("/orders/:id", async (req, res) => {
  const { status, quantity, metadata, salesOrderId } = req.body as {
    status?: string;
    quantity?: number;
    metadata?: Prisma.InputJsonValue;
    salesOrderId?: string;
  };
  // Stage 02: the ProductionOrder being patched must belong to the
  // caller's own enterprise — Prisma's update() can only target by its
  // unique id, so this is a scoped existence check first, same shape
  // already used for salesOrderId just below.
  const existingOrder = await prisma.productionOrder.findFirst({
    where: { id: req.params.id, enterpriseId: req.identity!.enterpriseId },
  });
  if (!existingOrder) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  // Remediation: a ProductionOrder.salesOrderId must point back to a real
  // SalesOrder — same "clean 404 beats a raw FK constraint 500" reasoning
  // as the fulfillment-lines PATCH above. Stage 02: also scoped by
  // enterprise, same reasoning as POST /orders.
  if (salesOrderId) {
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { id: salesOrderId, enterpriseId: req.identity!.enterpriseId },
    });
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
  //
  // Stage 01: same reasoning as POST /orders above — the update already
  // committed, so a publish failure is reported, not turned into a 500.
  const syncError = await publishTracked(
    TOPICS.ORDERS_PRODUCTION_UPDATED,
    { orderId: order.id, plantId: order.plantId, status: order.status, quantityChanged: quantity !== undefined },
    { operation: "PATCH /orders/:id", entityId: order.id }
  );
  if (syncError) {
    logger.error("Downstream sync failed after commit", {
      operation: syncError.operation,
      target: syncError.target,
      entityId: syncError.entityId,
      cause: String(syncError.cause),
    });
    res.json({ ...order, syncWarning: syncError.message });
    return;
  }
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
  // Stage 02: scoped by enterprise before any delete happens.
  const existingOrder = await prisma.productionOrder.findFirst({
    where: { id: orderId, enterpriseId: req.identity!.enterpriseId },
  });
  if (!existingOrder) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
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
