-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REJECTED');

-- AlterTable
ALTER TABLE "ResourceReservation" ADD COLUMN     "scheduleVersionId" TEXT;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "status" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "ScheduleRun" ADD COLUMN     "failureReason" TEXT;

-- AlterTable
ALTER TABLE "ScheduledOperation" ADD COLUMN     "scheduleVersionId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ResourceReservation_scheduleVersionId_idx" ON "ResourceReservation"("scheduleVersionId");

-- CreateIndex
CREATE INDEX "Schedule_plantId_status_idx" ON "Schedule"("plantId", "status");

-- CreateIndex
CREATE INDEX "ScheduledOperation_productionOrderId_supersededAt_idx" ON "ScheduledOperation"("productionOrderId", "supersededAt");

-- CreateIndex
CREATE INDEX "ScheduledOperation_scheduleVersionId_idx" ON "ScheduledOperation"("scheduleVersionId");

-- AddForeignKey
ALTER TABLE "ScheduledOperation" ADD CONSTRAINT "ScheduledOperation_scheduleVersionId_fkey" FOREIGN KEY ("scheduleVersionId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReservation" ADD CONSTRAINT "ResourceReservation_scheduleVersionId_fkey" FOREIGN KEY ("scheduleVersionId") REFERENCES "Schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stage 05 backfill: every existing Schedule row was added with the
-- column default (DRAFT), which is wrong for rows that already represent
-- a real completed run. The highest versionNumber per plant was the
-- active schedule at the time this migration runs; every other existing
-- row for that plant was already superseded (the application just never
-- recorded it). Rows for a plant with only one existing Schedule row are
-- correctly PUBLISHED by this same logic (max = only = itself).
WITH ranked AS (
  SELECT "id", "plantId",
         ROW_NUMBER() OVER (PARTITION BY "plantId" ORDER BY "versionNumber" DESC) AS rn
  FROM "Schedule"
)
UPDATE "Schedule" s
SET "status" = 'PUBLISHED'
FROM ranked r
WHERE s."id" = r."id" AND r.rn = 1;

WITH ranked AS (
  SELECT "id", "plantId",
         ROW_NUMBER() OVER (PARTITION BY "plantId" ORDER BY "versionNumber" DESC) AS rn
  FROM "Schedule"
)
UPDATE "Schedule" s
SET "status" = 'SUPERSEDED', "supersededAt" = COALESCE(s."supersededAt", now())
FROM ranked r
WHERE s."id" = r."id" AND r.rn > 1;

