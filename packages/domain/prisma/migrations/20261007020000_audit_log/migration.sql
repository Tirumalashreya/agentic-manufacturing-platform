-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "enterpriseId" TEXT,
    "traceId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_loggedAt_idx" ON "AuditLog"("entityType", "entityId", "loggedAt");

-- CreateIndex
CREATE INDEX "AuditLog_enterpriseId_idx" ON "AuditLog"("enterpriseId");

-- CreateIndex
CREATE INDEX "AuditLog_traceId_idx" ON "AuditLog"("traceId");

