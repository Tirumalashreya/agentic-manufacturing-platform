-- AlterTable
ALTER TABLE "AgentPipelineRun" ADD COLUMN     "approvalAction" TEXT,
ADD COLUMN     "approvalExpiresAt" TIMESTAMP(3),
ADD COLUMN     "approvalPayload" JSONB,
ADD COLUMN     "approvalStatus" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "executionResult" JSONB,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT,
ADD COLUMN     "requestedBy" TEXT;

-- CreateIndex
CREATE INDEX "AgentPipelineRun_approvalStatus_idx" ON "AgentPipelineRun"("approvalStatus");
