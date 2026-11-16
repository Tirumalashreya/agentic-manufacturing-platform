---
name: machine-service
description: Machine and work center management service (Port 4008). Tracks machine capabilities, operational status, downtime breakdowns, and sensor telemetry.
---

# Machine Service (`services/machine-service`)

## Overview
The `machine-service` owns the physical equipment master data, capability mappings, and real-time operational status.

## Core Capabilities
- **Capability Matching**: Associates machines with exact routing capabilities (e.g., `MILLING`, `TURNING`, `5-AXIS-CNC`).
- **Breakdown Reporting**: Exposes endpoints for operators or automated PLC monitors to flag machine failures. Publishes `MACHINES_BREAKDOWN_REPORTED` to trigger automatic rescheduling in `scheduling-service`.
- **Status Lifecycle**: Manages equipment states (`AVAILABLE`, `RUNNING`, `DOWN`, `MAINTENANCE`).

## Running & Testing
```bash
cd services/machine-service
npx tsx src/index.ts  # Runs on port 4008
npx vitest run        # Runs machine service tests
```
