---
name: analytics-service
description: Real-time operational intelligence and telemetry analytics service (Port 4017). Aggregates plant performance metrics and machine utilization.
---

# Analytics Service (`services/analytics-service`)

## Overview
The `analytics-service` computes real-time operational metrics across plants, work centers, and equipment.

## Core Capabilities
- **OEE (Overall Equipment Effectiveness)**: Availability $\times$ Performance $\times$ Quality tracking.
- **Machine Utilization**: Aggregate busy vs. idle time per work center.
- **On-Time Delivery (OTD)**: Historical tracking of confirmed promise dates versus actual goods dispatch dates.

## Running & Testing
```bash
cd services/analytics-service
npx tsx src/index.ts  # Runs on port 4017
```
