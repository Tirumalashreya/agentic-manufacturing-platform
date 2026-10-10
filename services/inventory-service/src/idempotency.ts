// Reuses the exact same claim-first IdempotencyKey mechanism order-service
// (Stage 03) and scheduling-service (Stage 05) already built — same table,
// same claim/replay/409-on-mismatch semantics, not a third implementation.
// inventory-service already has its own tenant-identity middleware
// (requireIdentity), so enterpriseId is simply req.identity!.enterpriseId
// at the call site — no plantId-based resolution needed here, unlike
// scheduling-service's copy.
//
// Added for the scrap-aware completion work: goods-issue/goods-receipt
// calls from mes-integration's per-step completion orchestration carry a
// stable, step-scoped Idempotency-Key (see ProductionCompletionStep's own
// schema comment) so a retried step can never create a second real
// InventoryMovement.
import { createHash } from "node:crypto";
import { prisma, type Prisma } from "@aps/domain";

const IDEMPOTENCY_HEADER = "idempotency-key";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

type MinimalRequest = { header(name: string): string | undefined; body: unknown };
type MinimalResponse = { status(code: number): { json(body: unknown): void } };

export async function withIdempotency(
  req: MinimalRequest,
  res: MinimalResponse,
  enterpriseId: string,
  operation: string,
  run: () => Promise<{ status: number; body: unknown }>
): Promise<void> {
  const key = req.header(IDEMPOTENCY_HEADER);
  if (!key) {
    const { status, body } = await run();
    res.status(status).json(body);
    return;
  }
  const requestHash = hashRequestBody(req.body);

  try {
    await prisma.idempotencyKey.create({ data: { enterpriseId, key, operation, requestHash, resultJson: {}, statusCode: 0 } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const existing = await prisma.idempotencyKey.findUnique({ where: { enterpriseId_key_operation: { enterpriseId, key, operation } } });
      if (existing && existing.requestHash !== requestHash) {
        res.status(409).json({ error: "This Idempotency-Key was already used for a different request" });
        return;
      }
      if (existing && existing.statusCode !== 0) {
        res.status(existing.statusCode).json(existing.resultJson as object);
        return;
      }
      res.status(409).json({ error: "A request with this Idempotency-Key is already in progress" });
      return;
    }
    throw err;
  }

  let outcome: { status: number; body: unknown };
  try {
    outcome = await run();
  } catch (err) {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId, key, operation } });
    throw err;
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId, key, operation } });
    res.status(outcome.status).json(outcome.body);
    return;
  }

  await prisma.idempotencyKey.update({
    where: { enterpriseId_key_operation: { enterpriseId, key, operation } },
    data: { resultJson: outcome.body as Prisma.InputJsonValue, statusCode: outcome.status },
  });
  res.status(outcome.status).json(outcome.body);
}
