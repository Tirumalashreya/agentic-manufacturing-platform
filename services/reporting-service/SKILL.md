---
name: reporting-service
description: Historical reporting and schedule audit query service (Port 4016). Queries ScheduleAuditLog and production KPIs.
---

# Reporting Service (`services/reporting-service`)

## Overview
The `reporting-service` exposes read-only historical reports on production orders, schedules, and audit events.

## Core Capabilities
- **Schedule Audit Trails**: Queries `ScheduleAuditLog` to inspect who approved or triggered schedule versions.
- **Production Performance**: Compiles order lead-time variance reports.

## Running & Testing
```bash
cd services/reporting-service
npx tsx src/index.ts  # Runs on port 4016
```
