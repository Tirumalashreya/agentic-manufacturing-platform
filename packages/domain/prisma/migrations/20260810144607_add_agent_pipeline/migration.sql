-- CreateTable
CREATE TABLE "AgentPipelineRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "currentStage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentPipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStageResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "agentOutput" JSONB NOT NULL,
    "humanEdited" JSONB,
    "editedByUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStageResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentStageResult_runId_idx" ON "AgentStageResult"("runId");

-- AddForeignKey
ALTER TABLE "AgentStageResult" ADD CONSTRAINT "AgentStageResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentPipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
