process.env.SERVICE_NAME = "order-service";

import { createHash, randomUUID } from "node:crypto";
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

// Phase 2 (crash-safe rewrite). The claim, the business write and the
// completion record now commit in ONE PostgreSQL transaction. Before, they
// were three separate statements, so a hard crash after the business write
// but before the completion update left a claim stuck at statusCode=0
// forever (a retry saw "in progress" for an operation that had in fact
// finished). Now there is no intermediate state to strand:
//   - crash/exception/non-2xx anywhere  -> everything rolls back, including
//     the claim; a retry runs fresh. Nothing was committed, so nothing can
//     be duplicated.
//   - success                          -> business rows, claim and stored
//     response are all visible together.
// No timeout-based "expire the claim" logic exists, deliberately: expiring a
// claim whose business write may have committed is exactly how a duplicate
// is created.
//
// Concurrency: the claim is INSERT ... ON CONFLICT DO NOTHING. If another
// transaction holds the same key uncommitted, Postgres makes this insert WAIT
// for it to commit or roll back; then it either replays the committed result
// (same request body), refuses (409, different body), or — if the other one
// rolled back — claims the key itself. A concurrent duplicate therefore
// replays the original response instead of getting a transient "in progress".
//
// `run` receives the transaction client and must do every write through it.
// Side effects that must not happen for a rolled-back request (event
// publishing) go in `afterCommit`; whatever it returns is merged into the
// live response body only (never stored for replay).
type IdempotencyTx = Prisma.TransactionClient;
type IdempotentOutcome = {
  status: number;
  body: unknown;
  afterCommit?: () => Promise<Record<string, unknown> | void>;
};

class IdempotencyRollback extends Error {
  constructor(public readonly outcome: IdempotentOutcome) {
    super("idempotent operation did not succeed; rolling back its claim");
  }
}

const IDEMPOTENCY_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

async function withIdempotency(
  req: Request,
  res: Response,
  operation: string,
  run: (tx: IdempotencyTx) => Promise<IdempotentOutcome>
): Promise<void> {
  const respond = async (outcome: IdempotentOutcome) => {
    let body = outcome.body;
    if (outcome.afterCommit) {
      const extra = await outcome.afterCommit();
      if (extra && body && typeof body === "object") body = { ...(body as object), ...extra };
    }
    res.status(outcome.status).json(body);
  };

  const key = req.header(IDEMPOTENCY_HEADER);
  if (!key) {
    // No key: no claim, but the multi-row writes inside `run` keep the single
    // transaction they always had (they used to open their own).
    await respond(await prisma.$transaction((tx) => run(tx), IDEMPOTENCY_TX_OPTIONS));
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;
  const requestHash = hashRequestBody(req.body);

  type Settled =
    | { kind: "done"; outcome: IdempotentOutcome }
    | { kind: "replay"; status: number; body: unknown }
    | { kind: "mismatch" }
    | { kind: "unresolved" };

  let settled: Settled;
  try {
    settled = await prisma.$transaction(async (tx): Promise<Settled> => {
      const claimed = await tx.$executeRaw`
        INSERT INTO "IdempotencyKey" ("id", "enterpriseId", "key", "operation", "requestHash", "resultJson", "statusCode")
        VALUES (${randomUUID()}, ${enterpriseId}, ${key}, ${operation}, ${requestHash}, '{}'::jsonb, 0)
        ON CONFLICT ("enterpriseId", "key", "operation") DO NOTHING`;
      if (claimed === 0) {
        const existing = await tx.idempotencyKey.findUnique({
          where: { enterpriseId_key_operation: { enterpriseId, key, operation } },
        });
        if (!existing) return { kind: "unresolved" }; // claim vanished between statements; caller retries
        if (existing.requestHash !== requestHash) return { kind: "mismatch" };
        // statusCode 0 can only be a claim stranded by the PRE-fix code path.
        if (existing.statusCode === 0) return { kind: "unresolved" };
        return { kind: "replay", status: existing.statusCode, body: existing.resultJson };
      }
      const outcome = await run(tx);
      if (outcome.status < 200 || outcome.status >= 300) throw new IdempotencyRollback(outcome);
      await tx.idempotencyKey.update({
        where: { enterpriseId_key_operation: { enterpriseId, key, operation } },
        data: { resultJson: outcome.body as Prisma.InputJsonValue, statusCode: outcome.status },
      });
      return { kind: "done", outcome };
    }, IDEMPOTENCY_TX_OPTIONS);
  } catch (err) {
    if (err instanceof IdempotencyRollback) {
      // A failed attempt must not be cached as this key's answer: the claim
      // rolled back with it, so a corrected retry with the same key runs.
      res.status(err.outcome.status).json(err.outcome.body);
      return;
    }
    throw err;
  }

  switch (settled.kind) {
    case "done":
      await respond(settled.outcome);
      return;
    case "replay":
      res.status(settled.status).json(settled.body);
      return;
    case "mismatch":
      // Same key, different request — never silently replay another request's result.
      res.status(409).json({ error: "This Idempotency-Key was already used for a different request" });
      return;
    case "unresolved":
      res.status(409).json({ error: "This Idempotency-Key has an unresolved claim from before crash-safe idempotency; use a new key" });
      return;
  }
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

// Phase 2: atomic find-or-create by name. The orchestrator used to do GET
// then POST, so two concurrent orders naming the same new customer both
// missed and both created one. A transaction-scoped advisory lock keyed on
// (enterprise, name) makes the lookup and the insert one critical section
// per name without serializing unrelated names, and without a unique
// constraint on Customer.name (names are not unique in general: ERP-sourced
// customers are keyed by externalCustomerId, and two real companies can
// share a name).
app.post("/customers/find-or-create", async (req, res) => {
  const { name, externalCustomerId, creditLimit, active } = req.body ?? {};
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
    res.status(400).json({ error: "name must be a non-empty string up to 200 characters" });
    return;
  }
  if (externalCustomerId !== undefined && (typeof externalCustomerId !== "string" || externalCustomerId.length < 1 || externalCustomerId.length > 100)) {
    res.status(400).json({ error: "externalCustomerId must be a 1-100 character string" });
    return;
  }
  if (creditLimit !== undefined && creditLimit !== null && (typeof creditLimit !== "number" || !Number.isFinite(creditLimit) || creditLimit < 0)) {
    res.status(400).json({ error: "creditLimit must be a non-negative number" });
    return;
  }
  if (active !== undefined && typeof active !== "boolean") {
    res.status(400).json({ error: "active must be a boolean" });
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;
  const { customer, created } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`customer:${enterpriseId}:${name}`}, 0))`;
    const existing = await tx.customer.findFirst({ where: { name, enterpriseId }, orderBy: { id: "asc" } });
    if (existing) {
      // Adopt the caller's external id / credit terms onto a legacy row that
      // never had them; never change values that are already set.
      const adopt: { externalCustomerId?: string; creditLimit?: number } = {};
      if (externalCustomerId && !existing.externalCustomerId) adopt.externalCustomerId = externalCustomerId;
      if (typeof creditLimit === "number" && existing.creditLimit === null) adopt.creditLimit = creditLimit;
      if (Object.keys(adopt).length === 0) return { customer: existing, created: false };
      return { customer: await tx.customer.update({ where: { id: existing.id }, data: adopt }), created: false };
    }
    return {
      customer: await tx.customer.create({
        data: { name, enterpriseId, externalCustomerId, creditLimit: creditLimit ?? undefined, active: active ?? true },
      }),
      created: true,
    };
  });
  res.status(created ? 201 : 200).json(customer);
});

// Phase 2: keyset-paged reads for reconciliation (tenant-scoped, id order).
function pageParams(req: Request): { after?: string; limit: number } {
  const limitRaw = Number(req.query.limit ?? 500);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 1000) : 500;
  const after = typeof req.query.after === "string" && req.query.after.length > 0 ? req.query.after : undefined;
  return { after, limit };
}
app.get("/customers/page", async (req, res) => {
  const { after, limit } = pageParams(req);
  const rows = await prisma.customer.findMany({
    where: { enterpriseId: req.identity!.enterpriseId, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: "asc" },
    take: limit + 1,
    select: { id: true, name: true, externalCustomerId: true, creditLimit: true, active: true },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({ items, nextAfter: hasMore ? items[items.length - 1].id : null });
});
app.get("/sales-orders/page", async (req, res) => {
  const { after, limit } = pageParams(req);
  const rows = await prisma.salesOrder.findMany({
    where: { enterpriseId: req.identity!.enterpriseId, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: "asc" },
    take: limit + 1,
    select: {
      id: true, externalOrderId: true, value: true, dueDate: true, status: true, createdAt: true,
      customer: { select: { externalCustomerId: true, name: true } },
      orderLines: { select: { productId: true, productName: true, quantity: true, unitPrice: true }, orderBy: { id: "asc" }, take: 1 },
    },
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  res.json({ items, nextAfter: hasMore ? items[items.length - 1].id : null });
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

  await withIdempotency(req, res, "create_sales_order_with_fulfillment", async (tx) => {
    const validationError = validateFulfillmentLines(lines, quantity ?? 0);
    if (validationError) return validationError;

    const result = await (async () => {
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
    })();

    return {
      // Best-effort audit row, written only after the order really committed.
      afterCommit: async () => {
        await writeSalesOrderAuditLog(req, result.salesOrder.id, enterpriseId, {
          externalOrderId: result.salesOrder.externalOrderId,
          status: result.salesOrder.status,
          strategy,
        });
      },
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
// Independent-audit finding (confirmed before fixing): this route was
// internally transactional (the OrderLine+FulfillmentPlan+FulfillmentLine
// creation below is one prisma.$transaction) but had no idempotency-key
// check at all — unlike the newer POST /sales-orders path, a client
// retry or double-submit created a second, independent OrderLine/
// FulfillmentPlan/FulfillmentLine set for the same SalesOrder, with
// nothing linking or deduping the two. Wrapped in the same withIdempotency
// helper POST /sales-orders already uses — an Idempotency-Key header is
// optional (omitting it preserves exactly today's behavior for every
// existing caller), but when present, a retry with the same key replays
// the original result instead of creating a second fulfillment plan.
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

  await withIdempotency(req, res, "create_fulfillment_for_sales_order", async (tx) => {
    // Stage 03: now the shared helper also used by the new atomic
    // POST /sales-orders path — same rule, one place.
    const validationError = validateFulfillmentLines(lines, quantity);
    if (validationError) return validationError;

    const result = await (async () => {
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
      // Phase 2: an order created ahead of its fulfillment plan (PostgreSQL
      // as first writer) has no fulfillmentType yet; record the plan's
      // strategy on it. A type that is already set is never overwritten.
      await tx.salesOrder.updateMany({
        where: { id: req.params.id, fulfillmentType: null },
        data: { fulfillmentType: strategy as never },
      });
      return { orderLine, fulfillmentPlan, fulfillmentLines };
    })();

    return {
      status: 201,
      body: {
        orderLineId: result.orderLine.id,
        fulfillmentPlanId: result.fulfillmentPlan.id,
        fulfillmentLines: result.fulfillmentLines.map((l) => ({ id: l.id, sourceType: l.sourceType })),
      },
    };
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

// Independent-audit finding (confirmed before fixing): Delivery and
// Invoice — the final two steps of order-to-cash — had zero Postgres
// presence anywhere in this schema. These two routes are the real write
// path for the new Delivery/Invoice tables (see schema.prisma's own
// comment on them for the full dual-write reasoning). Called from
// app/tools/delivery_tools.py / billing_tools.py as a best-effort mirror
// AFTER the Excel row is already written — the Excel write is never
// blocked or rolled back by a failure here, same philosophy as
// _dual_write_order_and_fulfillment already uses for SalesOrder.
//
// externalSalesOrderId is resolved to a real SalesOrder.id server-side,
// not trusted from the caller — a lookup by (enterpriseId,
// externalOrderId) within the caller's own enterprise, same pattern
// every other cross-tenant lookup in this file uses. No match (an order
// dual-written before this existed, or a channel — consignment, export —
// with no real SalesOrder row at all) is not an error: the row is still
// created, just with salesOrderId left null.
async function resolveSalesOrderId(
  enterpriseId: string,
  externalSalesOrderId: string | null | undefined,
  db: IdempotencyTx = prisma
): Promise<string | null> {
  if (!externalSalesOrderId) return null;
  const order = await db.salesOrder.findFirst({
    where: { enterpriseId, externalOrderId: externalSalesOrderId },
    select: { id: true },
  });
  return order?.id ?? null;
}

app.post("/deliveries", async (req, res) => {
  const {
    externalDeliveryId, externalSalesOrderId, customerId, customerName,
    productId, productName, quantity, status, requestedDeliveryDate, confirmedDeliveryDate,
  } = req.body as {
    externalDeliveryId: string;
    externalSalesOrderId?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    productId?: string | null;
    productName?: string | null;
    quantity: number;
    status: string;
    requestedDeliveryDate?: string | null;
    confirmedDeliveryDate?: string | null;
  };
  if (!externalDeliveryId) {
    res.status(400).json({ error: "externalDeliveryId is required" });
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;

  await withIdempotency(req, res, "create_delivery", async (tx) => {
    const salesOrderId = await resolveSalesOrderId(enterpriseId, externalSalesOrderId, tx);
    const delivery = await tx.delivery.upsert({
      where: { enterpriseId_externalDeliveryId: { enterpriseId, externalDeliveryId } },
      create: {
        enterpriseId, externalDeliveryId, externalSalesOrderId, salesOrderId,
        customerId, customerName, productId, productName, quantity, status,
        requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
        confirmedDeliveryDate: confirmedDeliveryDate ? new Date(confirmedDeliveryDate) : null,
      },
      // A retry of the SAME externalDeliveryId (e.g. the Excel write
      // succeeded, the Postgres mirror call timed out, and the caller's
      // own retry logic resends it) converges on the same row rather
      // than erroring — update is identical to create here since the
      // mock-ERP row this mirrors is itself immutable after creation.
      update: {
        externalSalesOrderId, salesOrderId, customerId, customerName, productId, productName, quantity, status,
        requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
        confirmedDeliveryDate: confirmedDeliveryDate ? new Date(confirmedDeliveryDate) : null,
      },
    });
    return { status: 201, body: delivery };
  });
});

app.post("/invoices", async (req, res) => {
  const {
    externalInvoiceId, externalSalesOrderId, externalDeliveryId, customerId, customerName,
    quantityBilled, unitPrice, invoiceAmount, paymentTermsDays, dueDate, status, notes,
  } = req.body as {
    externalInvoiceId: string;
    externalSalesOrderId?: string | null;
    externalDeliveryId?: string | null;
    customerId?: string | null;
    customerName?: string | null;
    quantityBilled: number;
    unitPrice: number;
    invoiceAmount: number;
    paymentTermsDays?: number | null;
    dueDate?: string | null;
    status: string;
    notes?: string | null;
  };
  if (!externalInvoiceId) {
    res.status(400).json({ error: "externalInvoiceId is required" });
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;

  await withIdempotency(req, res, "create_invoice", async (tx) => {
    const salesOrderId = await resolveSalesOrderId(enterpriseId, externalSalesOrderId, tx);
    const invoice = await tx.invoice.upsert({
      where: { enterpriseId_externalInvoiceId: { enterpriseId, externalInvoiceId } },
      create: {
        enterpriseId, externalInvoiceId, externalSalesOrderId, externalDeliveryId, salesOrderId,
        customerId, customerName, quantityBilled, unitPrice, invoiceAmount,
        paymentTermsDays, status, notes,
        dueDate: dueDate ? new Date(dueDate) : null,
      },
      update: {
        externalSalesOrderId, externalDeliveryId, salesOrderId, customerId, customerName,
        quantityBilled, unitPrice, invoiceAmount, paymentTermsDays, status, notes,
        dueDate: dueDate ? new Date(dueDate) : null,
      },
    });
    return { status: 201, body: invoice };
  });
});

// Phase 2 (Database Authority): Postgres-owned document ids. One atomic
// upsert-increment per call, so concurrent callers can never receive the
// same value. `floor` lets the first call start above the highest id the
// legacy Excel sheet already issued (value = max(lastValue, floor) + 1);
// the sequence never moves down. Gaps are possible (a caller that fails
// after allocating) and are fine — ids must be unique, not gapless.
const SEQUENCE_KINDS: Record<string, { table: string; column: string; prefix: string }> = {
  DELIVERY: { table: "Delivery", column: "externalDeliveryId", prefix: "DEL" },
  INVOICE: { table: "Invoice", column: "externalInvoiceId", prefix: "INV" },
  SALES_ORDER: { table: "SalesOrder", column: "externalOrderId", prefix: "SO" },
  CUSTOMER: { table: "Customer", column: "externalCustomerId", prefix: "C" },
};
app.post("/sequences/:kind/next", async (req, res) => {
  const kind = String(req.params.kind).toUpperCase();
  const spec = SEQUENCE_KINDS[kind];
  if (!spec) {
    res.status(400).json({ error: `Unknown sequence kind ${req.params.kind}` });
    return;
  }
  const floorRaw = req.body?.floor ?? 0;
  if (!Number.isInteger(floorRaw) || floorRaw < 0 || floorRaw > 2_000_000_000) {
    res.status(400).json({ error: "floor must be a non-negative integer" });
    return;
  }
  const key = req.body?.idempotencyKey;
  if (key !== undefined && (typeof key !== "string" || key.length < 1 || key.length > 200)) {
    res.status(400).json({ error: "idempotencyKey must be a 1-200 character string" });
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;

  const out = await prisma.$transaction(async (tx) => {
    if (key) {
      // Serialize concurrent requests for the SAME (enterprise, kind, key) so
      // exactly one of them allocates and the rest replay its number.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${enterpriseId}:${kind}:${key}`}, 0))`;
      const existing = await tx.documentNumberAllocation.findUnique({
        where: { enterpriseId_kind_idempotencyKey: { enterpriseId, kind, idempotencyKey: key } },
      });
      if (existing) return { value: existing.value, replayed: true };
    }
    // The sequence must never hand out a number a row already carries: the
    // caller's floor covers the legacy Excel sheet, this covers rows already
    // in Postgres (e.g. mirrored earlier, or left by earlier runs). The
    // table/column names come from the fixed map above, never from input.
    const pgMax = await tx.$queryRawUnsafe<{ m: number }[]>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING("${spec.column}" FROM ${spec.prefix.length + 1}) AS INTEGER)), 0) AS m
         FROM "${spec.table}" WHERE "enterpriseId" = $1 AND "${spec.column}" ~ '^${spec.prefix}[0-9]{1,9}$'`,
      enterpriseId
    );
    const floor = Math.max(floorRaw, Number(pgMax[0]?.m ?? 0));
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      INSERT INTO "DocumentSequence" ("id", "kind", "lastValue", "enterpriseId")
      VALUES (${randomUUID()}, ${kind}, ${floor + 1}, ${enterpriseId})
      ON CONFLICT ("enterpriseId", "kind")
      DO UPDATE SET "lastValue" = GREATEST("DocumentSequence"."lastValue", ${floor}) + 1
      RETURNING "lastValue"`;
    const value = rows[0].lastValue;
    if (key) {
      await tx.documentNumberAllocation.create({ data: { enterpriseId, kind, idempotencyKey: key, value } });
    }
    return { value, replayed: false };
  });
  res.status(200).json({ kind, value: out.value, replayed: out.replayed });
});

// Phase 2 (Database Authority): read side for reconciliation. Delivery and
// Invoice were write-only to Postgres (mirror), so nothing could compare
// the two stores. Enterprise-scoped from the verified identity like every
// other route here; keyset-paginated on the external id (stable, unique per
// enterprise) so a reconciler can walk the whole table without offset drift
// while rows are being written.
const RECONCILE_PAGE_MAX = 1000;
function parsePageLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), RECONCILE_PAGE_MAX);
}

app.get("/deliveries", async (req, res) => {
  const { after } = req.query as { after?: string };
  const take = parsePageLimit(req.query.limit);
  const rows = await prisma.delivery.findMany({
    where: { enterpriseId: req.identity!.enterpriseId, ...(after ? { externalDeliveryId: { gt: after } } : {}) },
    orderBy: { externalDeliveryId: "asc" },
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  res.json({ items, nextAfter: hasMore ? items[items.length - 1].externalDeliveryId : null });
});

app.get("/invoices", async (req, res) => {
  const { after } = req.query as { after?: string };
  const take = parsePageLimit(req.query.limit);
  const rows = await prisma.invoice.findMany({
    where: { enterpriseId: req.identity!.enterpriseId, ...(after ? { externalInvoiceId: { gt: after } } : {}) },
    orderBy: { externalInvoiceId: "asc" },
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  res.json({ items, nextAfter: hasMore ? items[items.length - 1].externalInvoiceId : null });
});

// Phase 2: the only post-creation Invoice state change that exists today is
// ISSUED -> PAID (Excel's mark_invoice_paid). It was never mirrored to
// Postgres, so every paid invoice stayed ISSUED here. Atomic compare-and-set
// on the current status (same pattern as the approval claim and the
// production-order completion claim): two concurrent callers cannot both
// "win", and a repeat of an already-applied PAID is an idempotent 200, not
// an error, so the Python caller can retry safely.
app.patch("/invoices/:externalInvoiceId/status", async (req, res) => {
  const { externalInvoiceId } = req.params;
  const { status } = req.body as { status?: string };
  if (status !== "PAID") {
    res.status(400).json({ error: "Only status PAID is supported (ISSUED -> PAID)" });
    return;
  }
  const enterpriseId = req.identity!.enterpriseId;
  const where = { enterpriseId_externalInvoiceId: { enterpriseId, externalInvoiceId } };

  const claimed = await prisma.invoice.updateMany({
    where: { enterpriseId, externalInvoiceId, status: "ISSUED" },
    data: { status: "PAID" },
  });
  const current = await prisma.invoice.findUnique({ where });
  if (!current) {
    res.status(404).json({ error: `Invoice ${externalInvoiceId} not found` });
    return;
  }
  if (claimed.count === 1 || current.status === "PAID") {
    res.json(current);
    return;
  }
  res.status(409).json({ error: `Cannot mark ${externalInvoiceId} paid from status ${current.status}` });
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
  await withIdempotency(req, res, "create_production_order", async (tx) => {
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
    const plant = await tx.plant.findFirst({ where: { id: plantId, site: { enterpriseId: req.identity!.enterpriseId } } });
    if (!plant) {
      return { status: 404, body: { error: `No Plant found with id ${plantId}` } };
    }

    let priorityScore = manualOverride ?? 0;
    if (salesOrderId) {
      // Stage 02: scoped by enterprise — a SalesOrder from another
      // enterprise is treated as not found, same as everywhere else, rather
      // than silently skipping the priority computation.
      const salesOrder = await tx.salesOrder.findFirst({
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

    const order = await tx.productionOrder.create({
      data: {
        plantId, salesOrderId, productId, routingId, bomId, quantity, priorityScore, status: "PLANNED", metadata,
        enterpriseId: req.identity!.enterpriseId,
      },
    });
    logger.info("Production order created", { orderId: order.id, priorityScore });

    // Stage 01 (Fail Loud, Fail Closed): once the ProductionOrder commits, a
    // publish failure must never become an HTTP 500 (which would invite a
    // retry that duplicates the order). Phase 2: the publish now runs in
    // afterCommit, i.e. only for an order that actually committed (it used to
    // fire inside the request, before the commit was durable). A failure is
    // logged in full and surfaced as a visible syncWarning on an otherwise
    // normal 201 — in the live response only, never in the stored replay.
    // Residual gap (Phase 3, outbox): a crash between commit and publish
    // loses the event; the order itself is safe and a retry replays it.
    return {
      status: 201,
      body: order,
      afterCommit: async () => {
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
          return { syncWarning: syncError.message };
        }
      },
    };
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
