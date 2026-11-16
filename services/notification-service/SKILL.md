---
name: notification-service
description: Real-time alert and notification relay service (Port 4014). Dispatches email alerts via Resend and streams live SSE updates to web dashboards.
---

# Notification Service (`services/notification-service`)

## Overview
The `notification-service` monitors the Kafka event bus and routes critical alerts to human operators and connected browser interfaces.

## Core Capabilities
- **Email Dispatch (Resend)**: Consumes `MACHINES_BREAKDOWN_REPORTED`, `INVENTORY_SHORTAGE_DETECTED`, and `MAINTENANCE_ORDERS_CREATED` to alert plant supervisors via email.
- **SSE Dashboard Relay**: Subscribes to `ORDERS_PRODUCTION_CREATED`, `ORDERS_PRODUCTION_UPDATED`, and `SCHEDULE_PUBLISHED`, broadcasting live Server-Sent Events (SSE) to connected web clients so Gantt charts update in real time.

## Running & Testing
```bash
cd services/notification-service
npx tsx src/index.ts  # Runs on port 4014
```
