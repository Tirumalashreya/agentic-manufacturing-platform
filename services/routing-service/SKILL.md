---
name: routing-service
description: Manufacturing engineering service (Port 4002). Manages Bills of Materials (BOM), routing operations, work center assignments, and predecessor dependencies.
---

# Routing Service (`services/routing-service`)

## Overview
The `routing-service` acts as the engineering master data repository, defining how products are manufactured.

## Core Capabilities
- **Bill of Materials (BOM)**: Multi-level component explosion defining parts, quantities, and scrap allowances per unit.
- **Routing Sequences**: Ordered operational steps (`opNumber: 10, 20, 30...`) with setup times, processing times per unit, required tooling, and required skills.
- **Operation Dependencies**: Predecessor-successor graphs (`FINISH_TO_START`, `START_TO_START` with lag).

## Running & Testing
```bash
cd services/routing-service
npx tsx src/index.ts  # Runs on port 4002
```
