-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "externalCustomerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_enterpriseId_externalCustomerId_key" ON "Customer"("enterpriseId", "externalCustomerId");

