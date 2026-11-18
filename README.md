# Enterprise Autonomous Planning & Scheduling (APS) and Order-to-Cash (O2C) Platform
### *Tier-1 Enterprise Architecture Equivalent to SAP S/4HANA & Oracle Cloud SCM*

---

## 1. Executive Summary & Value Proposition

Why would a Tier-1 enterprise manufacturer (Boeing, Siemens, Lockheed Martin) buy this platform rather than relying solely on incumbent ERPs?

Standard enterprise ERPs (SAP S/4HANA, Oracle Fusion, Microsoft Dynamics 365) are **systems of record**, not intelligent autonomous execution engines:
- **SAP S/4HANA Advanced ATP / PP-DS** and **Oracle Cloud SCM** require massive upfront configuration, rigid static lead-time master data, and manual dispatching interventions. When shop-floor disruptions occur (machine breakdowns, vendor component stockouts), planners spend hours in spreadsheets formulating manual workarounds.
- **Cognitive NLP & Disruption Agility**: Incumbent systems cannot parse unstructured natural language RFQs (emails, PDF spec sheets) directly into cryptographically signed sales proposals with instant, multi-constraint Capable-to-Promise (CTP) mathematical verification.
- **The "Trojan Horse" Integration Model**: This platform is designed not to replace the SAP General Ledger (FI/CO), but to act as the **high-speed cognitive scheduling & promising sidecar** that bi-directionally syncs with SAP/Oracle via standard OData v4 and REST webhooks.

---

## 2. Strict Architectural Division: Where AI Belongs vs. Where It Is Banned

In mission-critical aerospace and industrial manufacturing, hallucination in execution is unacceptable. Our system enforces a strict boundary:

| Functional Domain | System Component | Technology Stack | Architectural Rule |
| :--- | :--- | :--- | :--- |
| **RFQ Intake & Parsing** | Cognitive Agent Layer | LLM / Pattern Entity Extraction | **AI Applied**: Converts messy unstructured customer emails into structured ERP line items. |
| **Disruption What-If Copilot** | Scenario Simulation Engine | Hybrid AI + CP-SAT | **AI Applied**: Formulates multi-objective Pareto trade-offs (Reroute vs. Overtime vs. Expedite). |
| **Finite Capacity Scheduling** | Master Job-Shop Engine | **Google OR-Tools CP-SAT (MILP)** | **STRICTLY DETERMINISTIC**: Zero AI hallucination. Mathematical optimization guarantees non-overlapping intervals, sequence-dependent setup matrix minimization, and routing precedence. |
| **Capable-to-Promise (CTP)** | Promise Engine | Exact Finite Timeline Query | **STRICTLY DETERMINISTIC**: Calculates exact earliest completion minute based on live machine queues. |
| **Financial & Credit Ledger** | Double-Entry & Credit Master | PostgreSQL / SQLite ACID | **STRICTLY DETERMINISTIC**: Enforces credit limits, net terms, and double-entry consistency. |
| **Governance & SOX Compliance** | Approval Gatekeeper | CAS Cryptographic Token | **HUMAN-IN-THE-LOOP**: No AI agent can mutate the authoritative ERP ledger without an explicit human sign-off token. |

---

## 3. End-to-End Order-to-Cash (O2C) Lifecycle

The platform models the standard SAP Sales and Distribution (SD) and Oracle Order Management document flow:

```
+-------------------------------------------------------------------------------------------------------+
|                                    ORDER-TO-CASH (O2C) PIPELINE                                       |
+-------------------------------------------------------------------------------------------------------+
|  [ Step 01: Inbound RFQ ]                                                                             |
|      * Cognitive parser extracts: Customer, SKU, Quantity, Requested Date                             |
|      * Automated credit check verifies current exposure against ERP credit limit                      |
|                                        |                                                              |
|                                        v                                                              |
|  [ Step 02: Capable-to-Promise (CTP) Evaluation ]                                                     |
|      * Finite scheduler checks MTS safety stock or computes MTO earliest finish date                  |
|      * Generates cryptographically hashed Proposal Token (e.g., appr-857fb053fcba)                    |
|                                        |                                                              |
|                                        v                                                              |
|  [ Step 03: Human-in-the-Loop Digital Sign-Off ]                                                      |
|      * Commercial Director signs proposal (celebrated with UI Confetti)                               |
|      * SOX Compliance Audit Trail logs actor, timestamp, and token hash                               |
|                                        |                                                              |
|                                        v                                                              |
|  [ Step 04: Authoritative Sales Order (SAP VBAK / Oracle SO) ]                                        |
|      * Confirmed Sales Order (SO-202611-XXXX) with promised delivery date                             |
|      * Automatic reservation of production slots across 9 machines                                    |
|                                        |                                                              |
|                                        v                                                              |
|  [ Step 05: Outbound Delivery Note / Goods Issue (SAP LIKP / VL01N) ]                                 |
|      * Delivery Note (DN-202611-XXXX) created with FedEx / UPS priority tracking                       |
|      * Post Goods Issue updates status to SHIPPED and deducts inventory                               |
|                                        |                                                              |
|                                        v                                                              |
|  [ Step 06: Customer Billing Invoice (SAP VBRK / VF01) ]                                              |
|      * Customer Invoice (INV-202611-XXXX) generated with Net 30 payment terms and tax                |
|      * Customer Payment Settlement clears invoice and replenishes credit balance                      |
+-------------------------------------------------------------------------------------------------------+
```

---

## 4. Master Scheduling & Shop-Floor Master Data

The plant model reflects **GAIC Chicago Plant (PLANT-01)** with 4 certified Work Centers and 9 high-precision machines:

1. **WC-CUT (Cutting & Blanking)**:
   - `LASER-01`: Amada 12kW Fiber Laser Cutter
   - `SAW-01`: Behringer High-Speed Band Saw
2. **WC-CNC (High-Precision Machining)**:
   - `CNC-01`: Haas VF-4SS 5-Axis VMC
   - `CNC-02`: DMG MORI DMU 50 5-Axis Machining Center
   - `LATHE-01`: Mazak Quick Turn 250MSY
3. **WC-ASSY (Assembly & Staging)**:
   - `ASY-01`: Automated Robotic Assembly Cell
   - `ASY-02`: Manual Aerospace Assembly Bench
4. **WC-PACK (Finishing, Quality & Packaging)**:
   - `CMM-01`: Zeiss Contura Coordinate Measuring Machine (QA)
   - `PACK-01`: Automated Packaging & Crating Unit

---

## 5. System Architecture & Tech Stack

- **Backend**:
  - Python 3.11+ / FastAPI async server
  - SQLAlchemy 2.0 with `asyncpg` (PostgreSQL) and `aiosqlite` (SQLite)
  - Google OR-Tools CP-SAT constraint programming solver
  - Pydantic Settings for zero-friction environment switching
- **Frontend**:
  - React 19 + TypeScript + Vite 8
  - Tailwind CSS with customized dark enterprise HUD design
  - Canvas Confetti for celebratory order execution animations
  - Lucide React iconography
- **Security & Compliance**:
  - CAS (Compare-And-Swap) approval tokens
  - SOX Section 404 audit logging with actor identity and immutable JSON payload capture

---

## 6. One-Click Quickstart

### Automated Launch
```bash
# Clone the repository
git clone -b tier1-enterprise-aps-platform https://github.com/Tirumalashreya/agentic-manufacturing-platform.git enterprise-aps-platform
cd enterprise-aps-platform

# Launch full platform (backend on :8080, frontend on :3002)
chmod +x scripts/run.sh
./scripts/run.sh
```

### Manual Service Launch
```bash
# Terminal 1: Backend
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8080 --reload

# Terminal 2: Frontend
cd frontend
npm install
npm run dev -- --port 3002
```

Navigate to `http://localhost:3002` in your browser.
