-- §12: "resource_reservations ... GiST exclusion constraint: no two
-- COMMITTED overlap same resource" — this is the actual conflict-detection
-- mechanism §6 step 9 relies on (Postgres rejects the second overlapping
-- COMMITTED reservation outright, rather than the app having to check first).
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ResourceReservation"
  ADD CONSTRAINT resource_reservation_machine_no_overlap
  EXCLUDE USING gist (
    "machineId" WITH =,
    tsrange("startTime", "endTime") WITH &&
  )
  WHERE (state = 'COMMITTED' AND "machineId" IS NOT NULL);

ALTER TABLE "ResourceReservation"
  ADD CONSTRAINT resource_reservation_operator_no_overlap
  EXCLUDE USING gist (
    "operatorId" WITH =,
    tsrange("startTime", "endTime") WITH &&
  )
  WHERE (state = 'COMMITTED' AND "operatorId" IS NOT NULL);