-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "metadata" JSONB;
