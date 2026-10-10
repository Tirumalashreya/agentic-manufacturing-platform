-- CreateEnum
CREATE TYPE "CompletionStepType" AS ENUM ('GOODS_ISSUE', 'GOODS_RECEIPT', 'FULFILLMENT_UPDATE', 'BILLING');

-- CreateEnum
CREATE TYPE "CompletionStepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "FulfillmentLine" ADD COLUMN     "fulfilledQuantity" DOUBLE PRECISION,
ADD COLUMN     "shortfallReason" TEXT;

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "actualGoodUnits" DOUBLE PRECISION,
ADD COLUMN     "actualTotalUnits" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ScheduledOperation" ADD COLUMN     "goodUnits" DOUBLE PRECISION,
ADD COLUMN     "rejectedUnits" DOUBLE PRECISION,
ADD COLUMN     "totalUnits" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ProductionCompletionStep" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "stepType" "CompletionStepType" NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" "CompletionStepStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionCompletionStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionCompletionStep_productionOrderId_idx" ON "ProductionCompletionStep"("productionOrderId");

-- CreateIndex
CREATE INDEX "ProductionCompletionStep_status_idx" ON "ProductionCompletionStep"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionCompletionStep_productionOrderId_stepType_stepKey_key" ON "ProductionCompletionStep"("productionOrderId", "stepType", "stepKey");

-- AddForeignKey
ALTER TABLE "ProductionCompletionStep" ADD CONSTRAINT "ProductionCompletionStep_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
