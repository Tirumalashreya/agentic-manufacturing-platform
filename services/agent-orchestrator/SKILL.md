---
name: agent-orchestrator-service
description: Python FastAPI and LangGraph multi-agent orchestration service. Manages O2C sales workflows, Capable-to-Promise reasoning, ERP adapters (Postgres, SAP, Oracle), and human approval state machines.
---

# Agent Orchestrator (`services/agent-orchestrator`)

## Overview
The `agent-orchestrator` service executes end-to-end commercial and production planning workflows using LangGraph and Groq LLMs. It operates under strict architectural guardrails: **Agents Propose, Deterministic Tools Execute**.

## Architecture & Workflows

### 1. The 10 Commercial Workflows
1. `PRE_SALES`: Inquiry $\rightarrow$ Quotation with optional price negotiation $\rightarrow$ Sales Order.
2. `DIRECT_SALES`: High-speed order entry $\rightarrow$ Credit check $\rightarrow$ Fulfillment routing.
3. `POST_SALES`: Returns, RMA inspection, and Credit/Debit memos.
4. `TRADING`: Direct drop-ship sourcing without internal manufacturing.
5. `SERVICE`: Field technician work orders and milestone billing.
6. `PROJECT`: Milestone-based delivery, retention withholding, and billing.
7. `EXPORT`: Incoterms, customs declarations, Letters of Credit, and freight tracking.
8. `CONSIGNMENT`: Stock allocation, customer warehouse ledger, and sell-through billing.
9. `SUBSCRIPTION`: Recurring billing periods and renewal schedules.
10. `FINANCIAL`: General ledger adjustments with two-step approval gating.

### 2. Clamped Agentic Design (Safety Boundaries)
- **Fulfillment Strategy ([fulfillment_agent.py](file:///Users/vyju/Downloads/agentic-manufacturing-platform-main/services/agent-orchestrator/app/agents/fulfillment_agent.py))**:
  - The LLM does **not** pick the strategy.
  - Calculated deterministically by `determine_fulfillment_strategy()` (`MTS`, `MTO`, `CTO`, `HYBRID`, `THIRD_PARTY`).
  - LLM provides human-readable context and fallback.
- **Procurement Sourcing ([procurement_agent.py](file:///Users/vyju/Downloads/agentic-manufacturing-platform-main/services/agent-orchestrator/app/agents/procurement_agent.py))**:
  - Pareto cost-vs-lead-time optimization (`select_optimal_vendor()`) guarantees optimal spend.
  - LLM writes justification for procurement officers.
- **Production Feasibility ([production_planning_agent.py](file:///Users/vyju/Downloads/agentic-manufacturing-platform-main/services/agent-orchestrator/app/agents/production_planning_agent.py))**:
  - Material shortages and unplaced operations deterministically override the LLM status.
- **Price Negotiation ([negotiation_agent.py](file:///Users/vyju/Downloads/agentic-manufacturing-platform-main/services/agent-orchestrator/app/agents/negotiation_agent.py))**:
  - Extracts customer target prices/percentages and evaluates them against policy brackets via `process_price_negotiation()`.

### 3. ERP Adapter Layer (`app/erp/`)
Switch backends via `ERP_BACKEND` in `.env`:
- **`postgres`**: Production-native adapter interfacing with Postgres and microservices (`PostgresERPAdapter`).
- **`sap`**: SAP S/4HANA OData V2 client (`SAPAdapter`).
- **`oracle`**: Oracle Fusion Cloud SCM Order Hub REST client (`OracleAdapter`).
- **`mock`**: Local development openpyxl fallback (`MockERPAdapter`).

### 4. Approval Security
- Proposals are cryptographically hashed via `approval_proposal.py`.
- Commits are claimed using atomic CAS: `UPDATE AgentPipelineRun WHERE approvalStatus = 'PENDING'`.

## Running the Service
```bash
cd services/agent-orchestrator
source .venv/bin/activate
uvicorn app.main:app --port 8000 --reload
```
