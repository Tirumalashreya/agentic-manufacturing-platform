---
name: iot-ingestion-service
description: High-throughput machine sensor streaming service (Port 4020). Ingests temperature, vibration, and spindle telemetry into Kafka.
---

# IoT Ingestion Service (`services/iot-ingestion`)

## Overview
The `iot-ingestion` service acts as the direct edge gateway for industrial IoT sensor payloads (vibration, spindle load, motor temperature).

## Core Capabilities
- **High-Throughput Ingestion**: Exposes lightweight endpoints for machine PLCs and IoT gateways.
- **Kafka Streaming**: Streams raw readings directly to the `MACHINES_SENSORS` Kafka topic without intermediate database write bottlenecks.

## Running & Testing
```bash
cd services/iot-ingestion
npx tsx src/index.ts  # Runs on port 4020
```
