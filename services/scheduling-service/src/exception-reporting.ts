// Stage 01 (Fail Loud, Fail Closed) — ARCHITECTURE_BASELINE.md §5/§6/§11.
//
// Pulled out of index.ts into its own side-effect-free module so this
// commit-then-publish logic can be imported by a test without importing
// index.ts itself — index.ts unconditionally binds the service's real
// HTTP port (app.listen), starts real Kafka consumers, and runs a
// setInterval demo ticker at module load, none of which a test may
// trigger as a side effect (the existing pipeline.*.test.ts files avoid
// this the same way, by only ever importing from ./pipeline).
//
// Both functions below throw only when the write itself fails (e.g. an
// invalid scheduledOperationId); a downstream publish failure is always
// returned as a typed DownstreamSyncError, never thrown and never
// swallowed — the caller (index.ts's route handlers) decides how to
// report it.
import { prisma } from "@aps/domain";
import { publishTracked, TOPICS, type DownstreamSyncError } from "@aps/shared";

export const EXCEPTION_TYPES = [
  "MACHINE_BREAKDOWN",
  "MATERIAL_SHORTAGE",
  "OPERATOR_UNAVAILABLE",
  "QUALITY_ISSUE",
  "MAINTENANCE",
  "BLOCKED",
  "OTHER",
] as const;

export const QC_RESULTS = ["PASS", "FAIL"] as const;

export async function reportProductionException(
  scheduledOperationId: string,
  type: (typeof EXCEPTION_TYPES)[number],
  note: string | null
) {
  const created = await prisma.productionException.create({
    data: { scheduledOperationId, type, note },
  });
  const syncError = await publishTracked(
    TOPICS.OPERATIONS_EXCEPTION_REPORTED,
    { exceptionId: created.id, scheduledOperationId, type: created.type, note: created.note },
    { operation: "scheduledOperation.exceptions", entityId: created.id }
  );
  return { created, syncError };
}

export async function recordQualityInspection(
  scheduledOperationId: string,
  result: (typeof QC_RESULTS)[number],
  note: string | null
) {
  const created = await prisma.qualityInspection.create({
    data: { scheduledOperationId, result, note },
  });
  const syncErrors: DownstreamSyncError[] = [];
  if (created.result === "FAIL") {
    const { syncError: exceptionSyncError } = await reportProductionException(scheduledOperationId, "QUALITY_ISSUE", note);
    if (exceptionSyncError) syncErrors.push(exceptionSyncError);
  }
  const inspectionSyncError = await publishTracked(
    TOPICS.QUALITY_INSPECTION_RECORDED,
    { inspectionId: created.id, scheduledOperationId, result: created.result, note: created.note },
    { operation: "scheduledOperation.qualityInspections", entityId: created.id }
  );
  if (inspectionSyncError) syncErrors.push(inspectionSyncError);
  return { created, syncErrors };
}
