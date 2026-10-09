-- Stage 02 (Tenant Isolation + Service Identity).
--
-- Backfill justification (reviewed before writing this migration, not
-- assumed): as of this migration, the real database has 6 Enterprise rows.
-- Direct inspection showed exactly ONE of them has any real infrastructure
-- or commercial activity at all:
--
--   seed-enterprise ("Demo Manufacturing Co") — 1 real Site, 1 real User,
--   1 real Plant (PLANT-01) with 2 WorkCenters, 3 ProductionOrders, and 34
--   ScheduleRuns.
--
-- The other 5 ("nil", and four "test-order-service-<uuid>" rows) each have
-- 1 Site and 1 Plant but ZERO WorkCenters, ZERO ProductionOrders, ZERO
-- ScheduleRuns, and ZERO Users — they are confirmed leftover fixtures from
-- order-service's own vitest suite (created in a test's beforeAll, never
-- cleaned up in afterAll, most likely from an interrupted run), not real
-- tenants. Two "Test Customer <uuid>" rows match two of those suffixes
-- exactly and have zero SalesOrders.
--
-- Every real Customer/SalesOrder/Inventory row in this database was
-- created through flows (the agent-orchestrator demo pipeline, direct
-- Prisma seeding) that have only ever run against seed-enterprise — there
-- is no other real candidate enterprise for any of this data, and no
-- fabrication is involved in backfilling it there. This is recorded here,
-- in a reviewable migration, rather than applied silently.

-- === Customer ===
ALTER TABLE "Customer" ADD COLUMN "enterpriseId" TEXT;
UPDATE "Customer" SET "enterpriseId" = 'seed-enterprise' WHERE "enterpriseId" IS NULL;
ALTER TABLE "Customer" ALTER COLUMN "enterpriseId" SET NOT NULL;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Customer_enterpriseId_idx" ON "Customer"("enterpriseId");

-- === SalesOrder ===
ALTER TABLE "SalesOrder" ADD COLUMN "enterpriseId" TEXT;
UPDATE "SalesOrder" SET "enterpriseId" = 'seed-enterprise' WHERE "enterpriseId" IS NULL;
ALTER TABLE "SalesOrder" ALTER COLUMN "enterpriseId" SET NOT NULL;
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "SalesOrder_enterpriseId_idx" ON "SalesOrder"("enterpriseId");

-- orderNumber/externalOrderId move from a global-unique index to a
-- per-enterprise composite unique index — real order-numbering schemes
-- (e.g. the mock-ERP's own "SO0001" counter) are per-tenant in reality;
-- this is strictly less restrictive than before (same within-tenant
-- guarantee, no cross-tenant collision risk introduced), so no existing
-- row can violate it.
DROP INDEX "SalesOrder_orderNumber_key";
DROP INDEX "SalesOrder_externalOrderId_key";
CREATE UNIQUE INDEX "SalesOrder_enterpriseId_orderNumber_key" ON "SalesOrder"("enterpriseId", "orderNumber");
CREATE UNIQUE INDEX "SalesOrder_enterpriseId_externalOrderId_key" ON "SalesOrder"("enterpriseId", "externalOrderId");

-- === ProductionOrder ===
-- Denormalized from the real, always-populated plantId -> Plant.siteId ->
-- Site.enterpriseId chain (plantId is NOT NULL on every existing row), not
-- a second, independently-guessed value.
ALTER TABLE "ProductionOrder" ADD COLUMN "enterpriseId" TEXT;
UPDATE "ProductionOrder" po
SET "enterpriseId" = s."enterpriseId"
FROM "Plant" p JOIN "Site" s ON p."siteId" = s.id
WHERE po."plantId" = p.id;
ALTER TABLE "ProductionOrder" ALTER COLUMN "enterpriseId" SET NOT NULL;
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ProductionOrder_enterpriseId_idx" ON "ProductionOrder"("enterpriseId");

-- === Inventory ===
ALTER TABLE "Inventory" ADD COLUMN "enterpriseId" TEXT;
UPDATE "Inventory" SET "enterpriseId" = 'seed-enterprise' WHERE "enterpriseId" IS NULL;
ALTER TABLE "Inventory" ALTER COLUMN "enterpriseId" SET NOT NULL;
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Inventory_enterpriseId_idx" ON "Inventory"("enterpriseId");
