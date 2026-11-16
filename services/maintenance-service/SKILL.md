---
name: maintenance-service
description: Equipment maintenance service (Port 4012). Manages preventive maintenance plans and scheduled downtime orders that block machine capacity.
---

# Maintenance Service (`services/maintenance-service`)

## Overview
The `maintenance-service` coordinates scheduled preventive maintenance and unplanned equipment repairs, ensuring maintenance windows are factored into the master production schedule.

## Core Capabilities
- **Maintenance Plans**: Defines recurring maintenance cycles based on calendar intervals or machine runtime hours.
- **Maintenance Orders**: Generates `MaintenanceOrder` records and publishes `MAINTENANCE_ORDERS_CREATED` via `publishTracked()`.
- **Capacity Blocking**: The `scheduling-service` consumes maintenance orders to reserve capacity buckets and prevent jobs from being assigned during service windows.

## Running & Testing
```bash
cd services/maintenance-service
npx tsx src/index.ts  # Runs on port 4012
npx vitest run        # Runs maintenance tests
```
