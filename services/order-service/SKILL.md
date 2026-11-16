---
name: order-service
description: Order management service (Port 4001). Owns SalesOrder and ProductionOrder lifecycles, fulfillment plans, customer tiers, and Promise Risk Inbox calculations.
---

# Order Service (`services/order-service`)

## Overview
The `order-service` is the canonical owner of commercial sales orders and shop-floor production orders. It enforces strict relational transactions, customer credit checks, and delivery promise risk tracking.

## Core Capabilities

### 1. Order Ownership & Atomic Transactions
- **`POST /sales-orders`**: Canonical path for creating `SalesOrder` + `OrderLine` + `FulfillmentPlan` + `FulfillmentLine` in a single ACID transaction.
- **`POST /orders`**: Creates `ProductionOrder` rows with dynamic priority scoring (`computePriorityScore`) and atomically stages `ORDERS_PRODUCTION_CREATED` into the Transactional Outbox.
- **`PATCH /orders/:id`**: Updates order status/quantity, staging `ORDERS_PRODUCTION_UPDATED` into the Outbox inside the transaction.

### 2. Promise Risk Tracking
- **`GET /sales-orders/promises`**: Evaluates active orders against live machine schedules.
- Flags risk status:
  - `ON_TRACK`: Scheduled finish is comfortably before promise date.
  - `AT_RISK`: Buffer is less than threshold.
  - `BREACHED`: Scheduled completion is strictly after promised delivery date.
  - `SCHEDULE_MISSING` / `SCHEDULE_STALE`: Data integrity alerts.

### 3. Customer Tier & Document Sequence Management
- `POST /sequences/:kind/next`: Atomic sequence allocator for human-readable IDs (`DEL0001`, `INV0001`).
- `POST /customers/find-or-create`: Advisory-locked customer lookup and registration.

## Running & Testing
```bash
cd services/order-service
npx tsx src/index.ts            # Runs on port 4001
npx vitest run src/app.test.ts  # Runs integration suite
```
