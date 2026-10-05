-- CreateEnum
CREATE TYPE "QcResult" AS ENUM ('PASS', 'FAIL');

-- CreateTable
CREATE TABLE "QualityInspection" (
    "id" TEXT NOT NULL,
    "scheduledOperationId" TEXT NOT NULL,
    "result" "QcResult" NOT NULL,
    "note" TEXT,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityInspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualityInspection_scheduledOperationId_idx" ON "QualityInspection"("scheduledOperationId");

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_scheduledOperationId_fkey" FOREIGN KEY ("scheduledOperationId") REFERENCES "ScheduledOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
