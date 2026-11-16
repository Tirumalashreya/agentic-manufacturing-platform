import type { TopicName } from "./topics";
import { publishTracked } from "./kafka";
import { logger } from "./logger";

export interface OutboxDelegate {
  outboxEvent: {
    create: (args: {
      data: {
        topic: string;
        payload: any;
        status?: string;
        enterpriseId?: string | null;
      };
    }) => Promise<{ id: string }>;
    findMany: (args: {
      where?: { status: string };
      take?: number;
      orderBy?: { createdAt: "asc" | "desc" };
    }) => Promise<Array<{ id: string; topic: string; payload: any; retryCount: number }>>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        publishedAt?: Date;
        lastError?: string | null;
        retryCount?: { increment: number };
      };
    }) => Promise<unknown>;
  };
}

/**
 * Stages an event into the Transactional Outbox table inside an existing Prisma transaction.
 * Ensures the event is committed atomically with the domain state mutation.
 */
export async function stageOutboxEvent(
  tx: OutboxDelegate,
  topic: TopicName,
  payload: Record<string, unknown>,
  enterpriseId?: string | null
): Promise<string> {
  const row = await tx.outboxEvent.create({
    data: {
      topic,
      payload,
      status: "PENDING",
      enterpriseId: enterpriseId ?? null,
    },
  });
  return row.id;
}

/**
 * Dispatches a single staged outbox event to Kafka.
 * Updates the row to PUBLISHED on success or increments retryCount on failure.
 */
export async function dispatchOutboxEvent(
  prismaClient: OutboxDelegate,
  event: { id: string; topic: string; payload: any; retryCount: number }
): Promise<boolean> {
  const syncError = await publishTracked(
    event.topic as TopicName,
    event.payload,
    { operation: "outbox-dispatch", entityId: event.id }
  );

  if (!syncError) {
    await prismaClient.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        lastError: null,
      },
    });
    return true;
  }

  const errMessage = syncError.cause instanceof Error ? syncError.cause.message : String(syncError);
  logger.warn(`Outbox event ${event.id} failed to publish to ${event.topic}: ${errMessage}`);

  await prismaClient.outboxEvent.update({
    where: { id: event.id },
    data: {
      status: event.retryCount >= 5 ? "FAILED" : "PENDING",
      lastError: errMessage,
      retryCount: { increment: 1 },
    },
  });
  return false;
}

/**
 * Sweeps and drains pending outbox events in creation order.
 */
export async function drainPendingOutbox(
  prismaClient: OutboxDelegate,
  limit: number = 50
): Promise<{ dispatched: number; failed: number }> {
  const pending = await prismaClient.outboxEvent.findMany({
    where: { status: "PENDING" },
    take: limit,
    orderBy: { createdAt: "asc" },
  });

  let dispatched = 0;
  let failed = 0;

  for (const item of pending) {
    const ok = await dispatchOutboxEvent(prismaClient, item);
    if (ok) dispatched++;
    else failed++;
  }

  return { dispatched, failed };
}
