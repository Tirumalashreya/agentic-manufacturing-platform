-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FulfillmentLineStatus" ADD VALUE 'ALLOCATED';
ALTER TYPE "FulfillmentLineStatus" ADD VALUE 'EXECUTION_CREATED';
ALTER TYPE "FulfillmentLineStatus" ADD VALUE 'FAILED';
ALTER TYPE "FulfillmentLineStatus" ADD VALUE 'ON_HOLD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FulfillmentSourceType" ADD VALUE 'BUY';
ALTER TYPE "FulfillmentSourceType" ADD VALUE 'DROP_SHIP';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SalesOrderStatus" ADD VALUE 'PARTIALLY_FULFILLED';
ALTER TYPE "SalesOrderStatus" ADD VALUE 'ON_HOLD';

-- AlterTable
ALTER TABLE "FulfillmentLine" ADD COLUMN     "executionReference" TEXT;

