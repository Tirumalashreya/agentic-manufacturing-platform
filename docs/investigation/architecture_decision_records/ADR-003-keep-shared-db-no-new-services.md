# ADR-003: Keep the shared-database service topology; add no new microservices

Status: Proposed

## Context
18 services share one Prisma schema; a contract enforces some boundaries (A1, G1). Docker and k8s manifests have never been run.

## Problem
Pressure to add services (reporting, procurement, agents) or to split databases because "enterprise products do".

## Options
1. Split databases per service. Requires distributed transactions, which the system does not need today.
2. **Keep one database; enforce single-writer-per-aggregate by contract; add libraries not services.**
3. Consolidate low-value services into modules.

## Decision
Option 2 now; Option 3 opportunistically (calendar/tool/operator/machine; optimization pair). No new services without an ADR showing the failure they solve.

## Consequences
Cross-entity transactions remain possible; independent deploys remain limited (shared client coupling); contract checks expand to cover single-writer rules.

## Risks
Hidden coupling via Prisma client; mitigate with expand/contract migrations and contract tests.

## Migration
Extend `architecture/contract.yaml` with a writer-per-table check.

## Evidence
`architecture/contract.yaml`, service/model table in baseline §2.
