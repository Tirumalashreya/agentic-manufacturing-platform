-- CreateEnum
CREATE TYPE "ExceptionType" AS ENUM ('MACHINE_BREAKDOWN', 'MATERIAL_SHORTAGE', 'OPERATOR_UNAVAILABLE', 'QUALITY_ISSUE', 'MAINTENANCE', 'BLOCKED', 'OTHER');

-- CreateTable
CREATE TABLE "ProductionException" (
    "id" TEXT NOT NULL,
    "scheduledOperationId" TEXT NOT NULL,
    "type" "ExceptionType" NOT NULL,
    "note" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionException_scheduledOperationId_idx" ON "ProductionException"("scheduledOperationId");

-- AddForeignKey
ALTER TABLE "ProductionException" ADD CONSTRAINT "ProductionException_scheduledOperationId_fkey" FOREIGN KEY ("scheduledOperationId") REFERENCES "ScheduledOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
