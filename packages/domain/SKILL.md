---
name: domain-package
description: Domain entity models, Prisma schema, finite-capacity scheduling math, and database constraints.
---

# Domain Package (`packages/domain`)

## Overview
The `@aps/domain` package is the core database authority and shared domain library for the entire platform. It provides the single source of truth for PostgreSQL schema migrations and industrial scheduling primitives.

## Key Modules

### 1. Prisma Data Models (`prisma/schema.prisma`)
- **Commercial & O2C**: `Customer`, `SalesOrder`, `OrderLine`, `FulfillmentPlan`, `FulfillmentLine`, `Delivery`, `Invoice`, `DocumentSequence`, `DocumentNumberAllocation`.
- **Manufacturing & APS**: `Product`, `BOM`, `BOMLine`, `Routing`, `RoutingOperation`, `RoutingOpDependency`, `WorkCenter`, `Machine`, `MachineCapability`, `Tool`, `ToolUsage`.
- **Labor & Calendars**: `Operator`, `Skill`, `OperatorSkill`, `Shift`, `WorkCenterShift`, `OperatorShift`, `FactoryCalendar`, `HolidayCalendar`.
- **Planning & Execution**: `ProductionOrder`, `ScheduledOperation`, `ResourceReservation`, `QualityInspection`, `ProductionException`, `ProductionCompletionStep`.
- **Optimization**: `ChangeoverMatrix` (sequence-dependent setup rules between product families).
- **Messaging & Observability**: `OutboxEvent` (Transactional Outbox), `AgentPipelineRun`, `AgentStageResult`, `ScheduleAuditLog`, `IdempotencyKey`.

### 2. Core Scheduling Engines (`src/`)
- `capacity-engine.ts`: 15-minute time-bucket capacity calculations clamped to exact unfloored timestamps.
- `constraint-engine.ts`: Precedence graph evaluation (CPM - Critical Path Method), early/late start calculation.
- `dispatch-rules.ts`: Standard industrial dispatch priority sorting:
  - **EDD** (Earliest Due Date)
  - **SPT** (Shortest Processing Time)
  - **LPT** (Longest Processing Time)
  - **CR** (Critical Ratio)
  - **ATCS** (Apparent Tardiness Cost with Setups)
  - **PRIORITY_SCORE** (Weighted score factoring customer SLA penalties and margin)
- `shift-expansion.ts`: Expansion of shift patterns and non-working holiday calendars into time windows.

### 3. Database Constraints
- **GiST Exclusion Constraints**: `resource_reservation_machine_no_overlap` and `resource_reservation_operator_no_overlap` physically prevent double-booking at the PostgreSQL engine level.

## Common Operations
```bash
# Generate Prisma Client after schema edits
npm run prisma:generate

# Run schema migrations
npm run prisma:migrate

# Run domain unit tests
npm test -w @aps/domain
```
