---
name: inventory-service
description: Inventory management service (Port 4010). Tracks stock on-hand, goods issues/receipts, BOM shortage detection, and vendor purchase orders.
---

# Inventory Service (`services/inventory-service`)

## Overview
The `inventory-service` manages stock balances, movements, and component shortage scans. It acts as the inventory authority for both shop-floor production and commercial order fulfillment.

## Core Capabilities

### 1. Stock Movements & Transactions
- **`POST /inventory/goods-issue`**: Issues raw materials to a production order. Atomically decrements `qtyUnrestricted`, creates an `InventoryMovement`, and publishes `INVENTORY_MOVEMENT_RECORDED` safely via `publishTracked()`.
- **`POST /inventory/goods-receipt`**: Credits finished goods or inbound purchase order receipts to stock (`qtyUnrestricted`), with idempotency key protection (`productionOrderId:GOODS_RECEIPT:productId`).

### 2. BOM Shortage Scanning
- **`POST /inventory/scan-shortages`**: Checks open production orders against component stock and confirmed inbound purchase orders.
- Emits `INVENTORY_SHORTAGE_DETECTED` when projected stock falls below requirements.

### 3. Tenant Isolation
- All inventory queries are scoped by `enterpriseId` via HMAC-signed identity assertions (`requireInventoryIdentity`).

## Running & Testing
```bash
cd services/inventory-service
npx tsx src/index.ts  # Runs on port 4010
npx vitest run        # Runs inventory test suites
```
