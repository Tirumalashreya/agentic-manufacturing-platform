---
name: calendar-service
description: Factory calendar and shift service (Port 4013). Owns working day definitions, holiday schedules, and multi-level work-center calendar overrides.
---

# Calendar Service (`services/calendar-service`)

## Overview
The `calendar-service` provides working time definitions across the plant. It supports SAP-style multi-level calendar assignments (Plant, Work Center, and Shift).

## Core Capabilities
- **Factory Calendar**: Defines standard weekly working patterns (e.g., Monday–Friday, 24/7).
- **Holiday Schedules**: Non-working holiday dates that narrow available scheduling windows.
- **Work Center Overrides**: Allows specific work centers (e.g. continuous furnaces or automated lines) to operate on weekends even if the general plant is closed.

## Running & Testing
```bash
cd services/calendar-service
npx tsx src/index.ts  # Runs on port 4013
```
