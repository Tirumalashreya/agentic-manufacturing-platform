# ADR-001: Transactional outbox, idempotent consumers, dead-letter topic

Status: Proposed

## Context
Producers write to Postgres and then call `publish()` (`packages/shared/src/kafka.ts`). `publishTracked` stops a publish failure from becoming an HTTP 500, but the event is dropped. Consumers `JSON.parse` and run handlers with no dedupe (one reads an `eventId`) and no DLQ. `grep` for outbox/dlq/dead-letter returns nothing.

## Problem
A broker blip loses events (stale schedules, missed alerts); a redelivery may apply twice; a malformed message can block a partition.

## Options
1. Status quo plus alerting. Does not fix loss.
2. **Outbox table written in the domain transaction, relay publishes; inbox table for dedupe; DLQ topic.**
3. Debezium CDC. Heavier infrastructure; not justified at this scale.
4. Drop Kafka for DB-polled queues. Larger change; revisit if Kafka ops cost is high.

## Decision
Option 2, implemented in `packages/shared` (no new service). Event envelope with `eventId`, `version`, `traceId`, `enterpriseId`. Relay uses `FOR UPDATE SKIP LOCKED`. Five attempts, then DLQ.

## Consequences
At-least-once with effectively-once handlers; small publish delay; new tables and a relay loop per producing service.

## Risks
Relay lag; table growth (add retention); migration of 7+ producers and 8 consumers.

## Migration
Add tables; dual-publish behind a flag for one producer (order-service); verify with kill-broker test; roll out per producer; then consumers.

## Evidence
`kafka.ts:37`, baseline §6 (re-checked: `publishTracked` exists, outbox absent), `scheduling-service/index.ts:724` (only eventId use).
