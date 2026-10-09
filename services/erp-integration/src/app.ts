process.env.SERVICE_NAME = "erp-integration";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma } from "@aps/domain";

// Split out of index.ts (Stage 08) so vitest+supertest can exercise every
// real route against a real test-only Express instance without binding a
// port — same convention as order-service/maintenance-service's own
// app.ts split. index.ts is now just the process bootstrap (app.listen).
export const app = createApp();

// Stage 02 (Tenant Isolation): this endpoint models an INBOUND webhook from
// an external SAP/Oracle/D365 system, not an internal service call — there
// is no NextAuth session or internal caller identity to verify here the
// way order-service/inventory-service now require, and (per this file's
// own comment) no real SAP instance exists to integrate with, so this is
// not a live attack surface. The Customer/SalesOrder rows it creates are
// still tenant-owned now, so they need a real enterpriseId; this mock
// bridge, like the rest of this single-tenant demo system, represents the
// one real enterprise ARCHITECTURE_BASELINE.md's Stage 02 migration
// identified and backfilled everything else to — same explicit,
// deployer-configured pattern as manufacturing_services.py's
// AGENT_ORCHESTRATOR_ENTERPRISE_ID, not a silent per-request default.
const ERP_INTEGRATION_ENTERPRISE_ID = process.env.ERP_INTEGRATION_ENTERPRISE_ID ?? "seed-enterprise";

// §5 stage 1-2 / §11 "ERP Integration — Bi-directional SAP/Oracle/D365 sync
// (IDocs, BAPIs, REST) — erp.*". No real SAP/Oracle/D365 instance exists to
// integrate with here, so this is a mock adapter matching the documented
// contract shape (an IDoc-style payload in, a confirmed Sales Order out)
// rather than a real bi-directional sync.
//
// Stage 08 (Real ERP/MES Pilot Boundary) hardening of this one boundary:
// 1) External identifiers are real, separate fields now — externalCustomerId
//    (an SAP customer number in a real integration) and externalOrderId (an
//    SAP sales-document number) are the keys ERP actually uses; this
//    service's own Customer.id/SalesOrder.id stay internal and are never
//    exposed back to the caller as identity. Before this fix, the IDoc
//    handler used the customer's NAME as the Postgres primary key itself —
//    exactly the "external identity as a name" anti-pattern this stage
//    exists to close (a name is mutable and not what ERP keys on).
// 2) Idempotency: a real ERP redelivers IDocs (at-least-once delivery is
//    the norm, not the exception) — before this fix, every redelivery of
//    the same order created a second SalesOrder, unboundedly. Keying the
//    SalesOrder upsert on (enterpriseId, externalOrderId) — the same
//    @@unique constraint order-service's own dual-write already relies on
//    — makes a replayed IDoc a no-op read of the existing row (200) rather
//    than a duplicate write (201).
// 3) Explicit validation: a malformed/incomplete IDoc gets a clean 400
//    naming the missing field, never a raw 500 or a half-written row.
app.post("/erp/idocs/orders05", async (req, res) => {
  const { externalCustomerId, customerName, tier, slaDays, penaltyPerDay, dueDate, value, externalOrderId } = req.body as {
    externalCustomerId?: string;
    customerName?: string;
    tier?: "PLATINUM" | "GOLD" | "SILVER" | "STANDARD";
    slaDays?: number;
    penaltyPerDay?: number;
    dueDate?: string;
    value?: number;
    externalOrderId?: string;
  };

  const missing = ["externalCustomerId", "customerName", "dueDate", "value", "externalOrderId"].filter(
    (field) => req.body[field] === undefined || req.body[field] === null || req.body[field] === ""
  );
  if (missing.length > 0) {
    res.status(400).json({ error: `IDoc ORDERS05 missing required field(s): ${missing.join(", ")}` });
    return;
  }
  const parsedDueDate = new Date(dueDate!);
  if (Number.isNaN(parsedDueDate.getTime())) {
    res.status(400).json({ error: `Invalid dueDate: ${dueDate}` });
    return;
  }

  const customer = await prisma.customer.upsert({
    where: { enterpriseId_externalCustomerId: { enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID, externalCustomerId: externalCustomerId! } },
    create: {
      name: customerName!,
      tier: tier ?? "STANDARD",
      slaDays: slaDays ?? 14,
      penaltyPerDay: penaltyPerDay ?? 0,
      enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID,
      externalCustomerId,
    },
    update: { name: customerName!, tier: tier ?? "STANDARD", slaDays: slaDays ?? 14, penaltyPerDay: penaltyPerDay ?? 0 },
  });

  const existing = await prisma.salesOrder.findFirst({
    where: { enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID, externalOrderId },
  });
  if (existing) {
    logger.info("IDoc ORDERS05 replay — returning the existing SalesOrder, no duplicate written", {
      salesOrderId: existing.id,
      externalOrderId,
    });
    res.status(200).json({ salesOrder: existing, atpDate: existing.dueDate, replay: true });
    return;
  }

  const salesOrder = await prisma.salesOrder.create({
    data: { customerId: customer.id, dueDate: parsedDueDate, value, externalOrderId, enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID },
  });

  // "Confirmed Sales Order with ATP date" — a real ATP check cross-references
  // committed capacity/material; simplified here to the requested due date
  // itself, since that cross-check is exactly what the scheduling pipeline
  // does later in the flow.
  logger.info("IDoc ORDERS05 processed", { salesOrderId: salesOrder.id, customerId: customer.id, externalOrderId });
  res.status(201).json({ salesOrder, atpDate: salesOrder.dueDate, replay: false });
});

// Stage 08 (Reconciliation) — a minimal, real, deterministic check: every
// SalesOrder this ERP channel has ever created carries a real
// externalOrderId (Stage 08's fix above made that non-optional going
// forward), and every Customer this channel maintains carries a real
// externalCustomerId. A row owned by this channel missing either is a real
// data-integrity problem (e.g. a pre-Stage-08 row, or a bypass of this
// endpoint) — surfaced here, not silently ignored. This intentionally does
// NOT attempt to re-contact a live ERP (none exists) — reconciliation
// against a real external system is the next, separate step once a real
// ERP endpoint exists to query.
app.get("/erp/reconciliation", async (_req, res) => {
  const customersMissingExternalId = await prisma.customer.findMany({
    where: { enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID, externalCustomerId: null },
    select: { id: true, name: true },
  });
  const ordersMissingExternalId = await prisma.salesOrder.findMany({
    where: { enterpriseId: ERP_INTEGRATION_ENTERPRISE_ID, externalOrderId: null },
    select: { id: true, createdAt: true },
  });
  res.json({
    checkedAt: new Date().toISOString(),
    customersMissingExternalId,
    ordersMissingExternalId,
    status: customersMissingExternalId.length === 0 && ordersMissingExternalId.length === 0 ? "CLEAN" : "GAPS_FOUND",
  });
});

registerErrorHandler(app);
