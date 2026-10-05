-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'IN_FULFILLMENT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FulfillmentStrategy" AS ENUM ('MTS', 'MTO', 'CTO', 'THIRD_PARTY', 'TRADING', 'INTERCOMPANY', 'HYBRID');

-- CreateEnum
CREATE TYPE "FulfillmentSourceType" AS ENUM ('STOCK', 'PRODUCTION', 'VENDOR', 'TRANSFER');

-- CreateEnum
CREATE TYPE "FulfillmentLineStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED');

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN     "externalOrderId" TEXT,
ADD COLUMN     "fulfillmentType" "FulfillmentStrategy",
ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "requestedDate" TIMESTAMP(3),
    "warehouse" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentPlan" (
    "id" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "strategy" "FulfillmentStrategy" NOT NULL,
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FulfillmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentLine" (
    "id" TEXT NOT NULL,
    "fulfillmentPlanId" TEXT NOT NULL,
    "sourceType" "FulfillmentSourceType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "sourceLocation" TEXT,
    "destination" TEXT,
    "status" "FulfillmentLineStatus" NOT NULL DEFAULT 'PENDING',
    "promisedDate" TIMESTAMP(3),
    "actualDate" TIMESTAMP(3),
    "productionOrderId" TEXT,
    "vendorId" TEXT,
    "vendorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentPlan_orderLineId_key" ON "FulfillmentPlan"("orderLineId");

-- CreateIndex
CREATE INDEX "FulfillmentLine_fulfillmentPlanId_idx" ON "FulfillmentLine"("fulfillmentPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_orderNumber_key" ON "SalesOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "SalesOrder_externalOrderId_idx" ON "SalesOrder"("externalOrderId");

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentPlan" ADD CONSTRAINT "FulfillmentPlan_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentLine" ADD CONSTRAINT "FulfillmentLine_fulfillmentPlanId_fkey" FOREIGN KEY ("fulfillmentPlanId") REFERENCES "FulfillmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentLine" ADD CONSTRAINT "FulfillmentLine_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

