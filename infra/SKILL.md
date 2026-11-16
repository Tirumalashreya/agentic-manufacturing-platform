---
name: infrastructure
description: Deployment, container topologies, Docker Compose, Kubernetes manifests, and database backup/restore procedures.
---

# Infrastructure (`infra`)

## Overview
The `infra/` directory defines containerized topologies, deployment manifests, and operational maintenance scripts for the platform.

## Key Artifacts

### 1. Docker Compose (`infra/docker-compose.yml`)
Defines the complete local and staging multi-container topology:
- **PostgreSQL**: Primary relational store (`DATABASE_URL`).
- **Redis**: Distributed capacity bucket caches and plant locks (`REDIS_URL`).
- **Kafka & Zookeeper / KRaft**: Event streaming bus (`KAFKA_BROKER`).
- **ClickHouse**: High-throughput time-series sensor telemetry and OEE storage.
- Microservice container definitions with health check probes.

### 2. Operational Scripts (`infra/scripts/`)
- `backup-postgres.sh`: Custom-format `pg_dump` snapshot utility.
- `restore-postgres.sh`: Safe database restore into a dedicated verification schema/database before production promotion.

## Local Development vs. Production
- In local development, services run directly via `tsx` and `uvicorn` using local Kafka and PostgreSQL instances.
- In staging/production, deploy via `docker compose up -d` or apply the Kubernetes manifests under `infra/k8s/`.
