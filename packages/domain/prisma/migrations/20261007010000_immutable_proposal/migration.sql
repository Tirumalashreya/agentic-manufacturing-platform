-- AlterTable
ALTER TABLE "AgentPipelineRun" ADD COLUMN     "approvalCreatedAt" TIMESTAMP(3),
ADD COLUMN     "enterpriseId" TEXT,
ADD COLUMN     "proposalHash" TEXT;

-- CreateIndex
CREATE INDEX "AgentPipelineRun_enterpriseId_idx" ON "AgentPipelineRun"("enterpriseId");

