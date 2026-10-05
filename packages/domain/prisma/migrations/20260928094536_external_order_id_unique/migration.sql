-- DropIndex
DROP INDEX "SalesOrder_externalOrderId_idx";

-- AlterTable
ALTER TABLE "SalesOrder" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_externalOrderId_key" ON "SalesOrder"("externalOrderId");

