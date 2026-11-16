---
name: shared-package
description: Distributed infrastructure primitives, Kafka messaging, Transactional Outbox, Redis plant locking, auth tokens, and HTTP middleware.
---

# Shared Package (`packages/shared`)

## Overview
The `@aps/shared` package provides shared infrastructure utilities for all TypeScript microservices. It enforces standardized error handling, identity verification, distributed locking, and resilient messaging.

## Key Modules

### 1. Messaging & Transactional Outbox (`kafka.ts`, `outbox.ts`, `topics.ts`)
- **`publishTracked()`**: Safe Kafka publisher that returns `DownstreamSyncError` instead of throwing an uncaught exception, preventing committed database transactions from returning HTTP 500.
- **`stageOutboxEvent()`**: Atomically inserts an event into the `OutboxEvent` table inside a Prisma transaction:
  ```typescript
  await stageOutboxEvent(tx, TOPICS.ORDERS_PRODUCTION_CREATED, payload, enterpriseId);
  ```
- **`dispatchOutboxEvent()` & `drainPendingOutbox()`**: Sweeps and dispatches staged events with retry backoff.
- **`TOPICS`**: Strongly typed topic catalog (`ORDERS_PRODUCTION_CREATED`, `SCHEDULE_PUBLISHED`, etc.).

### 2. Distributed Locking & Caching (`redis.ts`)
- **`acquirePlantLock()` / `releasePlantLock()`**: Redis-based distributed lock with heartbeat renewal (`PLANT_LOCK_RENEWAL_INTERVAL_MS`), ensuring only one scheduling run executes per plant at any given time.
- **Capacity Buckets**: Fast in-memory window checks for machine capacity grids.

### 3. HTTP, Identity & Service Auth (`http.ts`, `serviceAuth.ts`, `identity.ts`)
- **`createApp()`**: Standardized Express setup with `express-async-errors`, correlation ID tagging (`x-trace-id`), and uniform health checks (`/health`, `/health/ready`).
- **`signIdentityAssertion()` / `verifyIdentityAssertion()`**: HMAC-signed assertions guaranteeing multi-tenant enterprise isolation between services.
- **`internalServiceHeaders()`**: Inter-service bearer authentication.

## Guidelines
- Never call plain `publish()` from an async HTTP route handler that has already committed a DB write. Always use `publishTracked()` or `stageOutboxEvent()`.
- Always forward `x-trace-id` on downstream HTTP calls.
