-- CreateTable
CREATE TABLE "DocumentNumberAllocation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enterpriseId" TEXT NOT NULL,

    CONSTRAINT "DocumentNumberAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentNumberAllocation_enterpriseId_kind_idempotencyKey_key" ON "DocumentNumberAllocation"("enterpriseId", "kind", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "DocumentNumberAllocation" ADD CONSTRAINT "DocumentNumberAllocation_enterpriseId_fkey" FOREIGN KEY ("enterpriseId") REFERENCES "Enterprise"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
