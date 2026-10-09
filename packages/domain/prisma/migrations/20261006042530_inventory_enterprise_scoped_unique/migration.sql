-- Stage 02 follow-up, found while writing this stage's own cross-tenant
-- test (not assumed safe): Inventory's unique key was [productId, location]
-- only. Product is shared/global this stage, so two different enterprises'
-- stock for "the same" productId+location would collide on ONE row — a
-- second enterprise's POST /inventory would silently overwrite the first
-- enterprise's quantities via the upsert's own WHERE clause, a real
-- cross-tenant write, not just a read leak. Including enterpriseId in the
-- key is strictly less restrictive than the key it replaces, so no
-- existing row (all of which belong to one real enterprise — see the
-- Stage 02 migration's own comment) can violate it.
DROP INDEX "Inventory_productId_location_key";
CREATE UNIQUE INDEX "Inventory_enterpriseId_productId_location_key" ON "Inventory"("enterpriseId", "productId", "location");
