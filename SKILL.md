---
name: agentic-manufacturing-platform
description: Comprehensive architecture, operational guide, and development skill for the Enterprise Agentic Manufacturing Platform (O2C Commercial Sales + Advanced Planning & Scheduling). Covers system design, role workspaces, Kafka event contracts, database authority, and all agentic boundaries.
---

# Enterprise Agentic Manufacturing Platform — Master Skill

## 1. System Overview & Core Purpose
This platform unites **Commercial Order-to-Cash (O2C)** and **Shop-Floor Advanced Planning & Scheduling (APS)** into a real-time, closed-loop manufacturing operating system.

It bridges the traditional enterprise divide between front-office sales promises and factory-floor execution:
- **Commercial Front Office (Port 3000, `frontend/`)**: Manages customer sales orders across 14 commercial variants (MTS, MTO, CTO, Project, Consignment, Export, Returns), credit checks, and real-time Capable-to-Promise (CTP).
- **Plant Operations & APS (Port 3001, `web/`)**: Manages finite-capacity machine scheduling (CPM), changeover matrices, work centers, operator skills, and touch-friendly shop-floor execution ("My Jobs").
- **Agent Orchestrator (Port 8000, `services/agent-orchestrator/`)**: Python LangGraph workflows with deterministic clamping, explainable AI verdict writers, and multi-ERP adapters (PostgreSQL, SAP S/4HANA OData, Oracle Fusion Cloud SCM).
- **Core Microservices (Ports 4001–4020, `services/`)**: Node.js/TypeScript microservices connected by PostgreSQL and Kafka event streams with Transactional Outbox guarantees.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE UNIFIED DATA CORE (PostgreSQL)                    │
│       Customers · SalesOrders · Inventory · WorkCenters · Schedules         │
└───────┬──────────────────────────────┬──────────────────────────────┬───────┘
        │                              │                              │
        ▼                              ▼                              ▼
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│ COMMERCIAL APP   │          │ CTP / AGENT CORE │          │ APS & SHOP FLOOR │
│ (Port 3000)      │◄────────►│ (Port 8000)      │◄────────►│ (Port 3001)      │
│                  │          │                  │          │                  │
│ • Quotes         │          │ • Real-time ATP  │          │ • Finite Gantt   │
│ • Order Entry    │          │ • CTP Simulator  │          │ • Changeovers    │
│ • Customer Credit│          │ • Exception Loop │          │ • Operator Shift │
│ • Promise Inbox  │          │ • AI Explainers  │          │ • "My Jobs" MES  │
└──────────────────┘          └──────────────────┘          └──────────────────┘
```

---

## 2. Directory Structure Map

```
.
├── frontend/                  # Commercial & O2C Web App (Port 3000) - Next.js
├── web/                       # APS Platform & Shop-Floor Terminal (Port 3001) - Next.js
├── packages/
│   ├── domain/                # Shared Prisma schema, migrations, capacity math, constraints
│   └── shared/                # Kafka client, Transactional Outbox, auth, logger, redis
├── services/
│   ├── agent-orchestrator/    # Python LangGraph AI orchestrator, ERP adapters (Postgres, SAP, Oracle)
│   ├── order-service/         # Port 4001 - Sales orders, production orders, fulfillment plans
│   ├── routing-service/       # Port 4002 - BOMs, routings, operations, dependencies
│   ├── scheduling-service/    # Port 4005 - Finite-capacity scheduler, CPM, changeovers
│   ├── optimization-service/  # Port 4006 - Load-balancing, TSP pass
│   ├── optimization-solver/   # Port 4007 - OR-Tools CP-SAT mathematical solver
│   ├── machine-service/       # Port 4008 - Machines, work centers, capabilities, telemetry
│   ├── operator-service/      # Port 4009 - Operators, skills, proficiencies, shift rosters
│   ├── inventory-service/     # Port 4010 - Stock levels, goods issue/receipt, shortage detection
│   ├── tool-service/          # Port 4011 - Tooling fixtures and wear tracking
│   ├── maintenance-service/   # Port 4012 - Preventive maintenance and downtime orders
│   ├── calendar-service/      # Port 4013 - Factory calendars, shift definitions, holidays
│   ├── notification-service/  # Port 4014 - Alerts, Resend email dispatch, SSE dashboard relay
│   ├── reporting-service/     # Port 4016 - Production KPIs and schedule audit queries
│   ├── analytics-service/     # Port 4017 - Real-time operational metrics and aggregations
│   ├── erp-integration/       # Port 4018 - Inbound SAP IDoc / EDI order ingestion
│   ├── mes-integration/       # Port 4019 - Execution sync, good/scrap units, step completion
│   └── iot-ingestion/         # Port 4020 - High-throughput machine sensor streaming
├── architecture/              # Architecture contract invariants & machine checks
├── scripts/                   # Platform launcher (start-platform.sh), master data seeds
└── docs/                      # Deep-dive architecture baselines and audit reports
```

---

## 3. Key Architectural Invariants & Rules

1. **Deterministic Authority**:
   - Machine placement, scheduling dates, credit math, and inventory reservations are computed **strictly by deterministic algorithms**.
   - No LLM ever computes a schedule or decides physical machine allocation.
2. **AI Boundary (Explainers, Not Rogues)**:
   - LLMs extract unstructured text (e.g. negotiation discount requests) and draft plain-language explanations for human approvers.
   - Core fulfillment strategies (`MTS`, `MTO`, `CTO`, `HYBRID`) and procurement vendor selections are clamped by deterministic code.
3. **Database-Enforced Concurrency**:
   - Machine and operator reservations are strictly guarded by PostgreSQL GiST exclusion constraints (`resource_reservation_machine_no_overlap`).
4. **Transactional Outbox for Messaging**:
   - Events are staged into the `OutboxEvent` table within the same database transaction as domain writes.
   - Unguarded Kafka `publish()` calls after commits are forbidden; always use `publishTracked()` or `stageOutboxEvent()`.
5. **Role-Separated Portals**:
   - Commercial users and factory schedulers use distinct portals (`:3000` vs `:3001`).

---

## 4. Platform Launch & Verification Commands

```bash
# Start all platform microservices and dual web portals
./scripts/start-platform.sh
# or
npm run start:platform

# Individual portals:
npm run dev:commercial    # http://localhost:3000
npm run dev:aps           # http://localhost:3001

# Verify architectural contract:
npm run check:architecture
npm run test:architecture
```
