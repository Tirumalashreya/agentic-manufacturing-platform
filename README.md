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
  - Python 3.11+ / FastAPI async server with zero deprecation warnings
  - SQLAlchemy 2.0 with `asyncpg` (PostgreSQL) and `aiosqlite` (SQLite)
  - Google OR-Tools CP-SAT constraint programming solver (mathematical non-overlap and setup minimization)
  - Pydantic Settings V2 for robust environment management
  - Automated test suite with 100% pass rate (`pytest tests/`)
- **Frontend Cockpit**:
  - React 19 + TypeScript + Vite 8
  - Industrial Titanium Cockpit (`#090a0d` matte graphite, subtle blueprint technical grid, 1px precision hairline borders)
  - Canvas Confetti for celebratory order execution animations
  - Real-time zero-latency table filtering and multi-attribute search
  - Interactive Master Gantt operation inspector drawer
  - One-click CSV exports for Sales Pipeline, Outbound Deliveries, Invoices, Inventory, Audit Trail, and Production Schedules
- **Security & Compliance**:
  - CAS (Compare-And-Swap) cryptographic approval tokens
  - SOX Section 404 audit logging with actor identity, timestamp, and immutable JSON payload capture

---

## 6. Installed Open-Source UI Engineering Skills

To eliminate generic AI SaaS tells and achieve Tier-1 enterprise software craft (Linear, Palantir, Apple caliber), 5 industry-standard skills are installed under `.agents/skills/`:

1. **`frontend-ui-engineering`** (`addyosmani/agent-skills`): Authored by Addy Osmani (Google Chrome Engineering Lead). Enforces component composition over prop-heavy configurations, keyboard accessibility (`Esc` drawer dismissal), explicit dual-indicator states (icons + text), and skeleton loaders.
2. **`impeccable`** (`pbakaus/impeccable`): Authored by Paul Bakaus (former jQuery UI & Google AMP Lead). Governs "Operate Mode" enterprise precision, dense information layouts, tabular scanability, and craftsmanship floors.
3. **`frontend-design`** (`anthropics/skills`): Official design studio guidelines from Anthropic eliminating generic AI tells (chopping everything into identical rounded cards, tracked-out ALL-CAPS eyebrows, middle dots).
4. **`premium-frontend-ui`** (`github/awesome-copilot`): GitHub flagship skill for high-craft digital environments, fluid typography, 1px hairline borders (`rgba(255,255,255,0.08)`), and hardware-accelerated animations.
5. **`tailwind-design-system`** (`wshobson/agents`): Modern CSS-first design tokens and compound component patterns.

---

## 7. Automated Test Suite & Verification

The backend includes a comprehensive automated test suite verifying constraint satisfaction and financial audit integrity:

```bash
cd backend
.venv/bin/pytest
```

**Test Coverage**:
- `test_finite_scheduler.py`: Verifies OR-Tools CP-SAT non-overlapping machine allocations, precedence ordering, and makespan minimization.
- `test_o2c_pipeline.py`: Verifies full 6-stage document flow from RFQ intake, CAS digital sign-off, Sales Order (`OR`), Planned Production Order (`AFKO`), Outbound Delivery (`LF`), to Billing Invoice (`F2`).
- `test_disruption_copilot.py`: Verifies machine failure blast-radius simulation, multi-scenario Pareto rankings, real-time Dynamic Reroute mitigation, and Weekend Overtime shift authorizations.

---

## 8. One-Click Quickstart

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
pytest
uvicorn app.main:app --port 8080 --reload

# Terminal 2: Frontend
cd frontend
npm install
npm run dev -- --port 3002
```

Navigate to `http://localhost:3002` in your browser.
