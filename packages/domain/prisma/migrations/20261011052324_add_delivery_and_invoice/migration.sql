-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "externalDeliveryId" TEXT NOT NULL,
    "externalSalesOrderId" TEXT,
    "salesOrderId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "requestedDeliveryDate" TIMESTAMP(3),
    "confirmedDeliveryDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enterpriseId" TEXT NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "externalInvoiceId" TEXT NOT NULL,
    "externalSalesOrderId" TEXT,
    "externalDeliveryId" TEXT,
    "salesOrderId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "quantityBilled" DOUBLE PRECISION NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "invoiceAmount" DOUBLE PRECISION NOT NULL,
    "paymentTermsDays" INTEGER,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enterpriseId" TEXT NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delivery_enterpriseId_idx" ON "Delivery"("enterpriseId");

-- CreateIndex
CREATE INDEX "Delivery_salesOrderId_idx" ON "Delivery"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_enterpriseId_externalDeliveryId_key" ON "Delivery"("enterpriseId", "externalDeliveryId");

-- CreateIndex
CREATE INDEX "Invoice_enterpriseId_idx" ON "Invoice"("enterpriseId");

-- CreateIndex
CREATE INDEX "Invoice_salesOrderId_idx" ON "Invoice"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_enterpriseId_externalInvoiceId_key" ON "Invoice"("enterpriseId", "externalInvoiceId");

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
