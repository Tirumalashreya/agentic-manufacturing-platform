---
name: scheduling-service
description: Deterministic finite-capacity manufacturing scheduler (Port 4005). Owns CPM, changeover matrix, dispatch rules, operator matching, and disruption replanning.
---

# Scheduling Service (`services/scheduling-service`)

## Overview
The `scheduling-service` is the single authoritative planning engine in the platform. It executes finite-capacity placement across machines and operators without relying on any external LLM calls.

## Core Capabilities

### 1. Scheduling Pipeline (`pipeline.ts`)
- **Placement Modes**:
  - `FORWARD`: Earliest feasible placement from material availability floor.
  - `BACKWARD`: Just-in-time placement working backward from requested due date.
  - `BOTTLENECK`: Identifies drum resource (max demand) and packs it tightly first.
- **Sequence-Dependent Changeover Matrix**:
  - Dynamically queries `ChangeoverMatrix` rules for `${machineId}:${fromFamily}:${toFamily}`.
  - Adjusts setup minutes when switching between different product families, avoiding flat-setup errors.
- **Operator Skills & Shift Alignment**:
  - Matches required routing skill IDs and minimum proficiencies against operator shift calendars.
- **Database Exclusion Guards**:
  - Postgres GiST exclusion constraints guarantee that no two committed operations overlap on the same machine or operator.

### 2. Disruption Handling & Scopes
- Automatically consumes Kafka events:
  - `MACHINES_BREAKDOWN_REPORTED`
  - `MACHINES_STATUS_CHANGED`
  - `ORDERS_PRODUCTION_UPDATED`
- Rescheduling Scopes:
  - `SINGLE`: Replans only the specified target order.
  - `AFFECTED`: Graph traversal identifying downstream successor orders impacted by delays.
  - `ALL`: Complete plant re-plan.
- What-If Simulation: Runs dry-run evaluations (`DryRunCtx`) without mutating committed schedule rows.

### 3. Transactional Outbox
- Stages `SCHEDULE_PUBLISHED` atomically into PostgreSQL before dispatching to Kafka.

## Running & Testing
```bash
cd services/scheduling-service
npx tsx src/index.ts  # Runs on port 4005
npx vitest run        # Runs scheduling test suites
```
