---
name: mes-integration-service
description: Manufacturing Execution System (MES) integration service (Port 4019). Manages shop-floor step progress, good vs scrap unit tracking, and finished goods receipts.
---

# MES Integration Service (`services/mes-integration`)

## Overview
The `mes-integration` service bridges physical shop-floor machinery and operator reporting with the platform. It handles the transition from scheduled operations to real-time execution.

## Core Capabilities
- **Step Execution Tracking**: Records `SETUP`, `PROCESSING`, `INSPECTION`, and `TEARDOWN` steps.
- **Good vs. Scrap Units**: Captures `actualGoodUnits` and `actualTotalUnits`, calculating scrap ratios.
- **Finished Goods Handoff**: Upon final routing operation completion, automatically invokes `POST /inventory/goods-receipt` to credit finished goods into warehouse inventory.
- **Billing Triggers**: Generates step-scoped keys (`{productionOrderId}:BILLING:billing`) to ensure idempotency when passing completed work orders to the commercial ledger.

## Running & Testing
```bash
cd services/mes-integration
npx tsx src/index.ts  # Runs on port 4019
npx vitest run        # Runs MES integration tests
```
