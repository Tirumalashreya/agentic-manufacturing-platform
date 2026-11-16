# Oracle Fusion SCM: product findings

**Honesty note.** Only one Oracle source was read in this investigation (the SCM AI feature index). Part 3 of the brief asks for 17 questions per workflow (data read and written, state transitions, validations, recovery). **That cannot be answered from the index page, and I did not fetch the ~260 per-feature readiness pages, the SCM integration playbooks or the product pages.** This document therefore has two parts. The first is verified, from the index. The second is a research plan with the questions to answer, plus clearly labeled `UNVERIFIED` general knowledge, so nobody mistakes it for evidence.

Source: https://docs.oracle.com/en/cloud/saas/fusion-ai/aiafl/ai-scm.html (fetched 2026-10-30).

## 1. VERIFIED: what Oracle's AI index shows

The page lists features from release 25A through 26D, tagged **AI agent**, **Agentic app**, **Predictive AI** or **Fusion Claw** (an undefined label used on 4 items: Procurement Spend Command Center, Sourcing Command Center scenario simulation, Shipment Load Planning Workspace, Supply Planning Allocation Workspace; all 26D). It lists about 260 entries (dozens of agents, 15 or so agentic apps, and the rest predictive AI or enhancements).

Relevant entries for our scope, with module and release exactly as listed:

| Oracle item | Module | Type | Release |
|---|---|---|---|
| Sales Order Assistant | Order Management | AI agent | 25D |
| Order Exception Assistant (+ enhancements) | Order Management | AI agent | 25D, 26A, 26C |
| Purchase Orders to Sales Orders Converter (+ via email) | Order Management | AI agent | 25D/26A, 26C |
| Sales Order Correction Assistant | Order Management | AI agent | 26C |
| Sales Order Command Center | Order Management | Agentic app | 26B, 26C/26D |
| Inventory Reservation Assistant (+ proactive recommendations) | Inventory Mgmt | AI agent | 26A, 26C |
| Inventory Shortages Assistant | Inventory Mgmt | AI agent | 26B |
| Inventory Planning Command Center | Demand Mgmt | Agentic app | 26C |
| Work Order Completion Assistant | Manufacturing | AI agent | 26B |
| Work Order Sync Assist | Manufacturing | AI agent | 26A |
| Operations Assignment Assistant | Manufacturing | AI agent | 26A |
| Disposition Assistant for Rejects | Manufacturing | AI agent | 25D |
| Production Shift Operations Workspace (+ enhanced advisors) | Manufacturing | Agentic app | 26B, 26C |
| Production Readiness Workspace | Manufacturing | Agentic app | 26C |
| Planning Advisor for Exceptions | Supply Planning | AI agent | 25D |
| Planning Order Release Assistant (+ batch, + root cause) | Supply Planning | AI agent | 26A, 26B, 26C |
| Autonomous Sourcing Assistant (+ enhancements) | Procurement | AI agent | 26A, 26B |
| Sourcing Command Center | Procurement | Agentic app | 26B |
| Supplier Qualification Workspace | Procurement | Agentic app | 26C |
| Quality Inspection Standards Advisor | Quality | AI agent | 25C |
| Quality Assurance Workspace | Quality | Agentic app | 26D |
| Maintenance Advisor / Work Order Builder / Maintenance Operations Workspace | Maintenance | AI agent / Agentic app | 25C, 25D, 26B |

**Observations that follow directly from the index:**
- The pattern is **many narrow, role-specific assistants per module, plus one workspace ("command center") per role**. It is not one big agent.
- The names are overwhelmingly advisor, assistant or guide. Only one carries "Autonomous" in its name: Autonomous Sourcing Assistant. **Whether any of these execute without approval is not stated on the index page. Do not infer it either way.**
- **Scheduling itself is not in the list.** Production scheduling and planning math do not appear as agents. The planning items are about exceptions, notes, order release and process advice around the planning engine. This is consistent with "agents sit around a deterministic engine", but it is only consistent with that. It does not prove it.
- Predictive AI is used in a few narrow places (classification code proposal, ETA, route prediction, slotting). These are the cases where a statistical or ML model is the right tool.

## 2. UNVERIFIED: general knowledge (check before use)

These are widely understood properties of Oracle Fusion SCM and have not been checked in this session:
- The order-to-cash chain runs through Order Management with Global Order Promising (ATP/CTP), Order Orchestration (Supply Chain Orchestration), Inventory, Shipping and Receivables.
- Manufacturing uses Work Definitions (BOM and routing together), work orders and shop-floor execution, and a separate planning application (Supply Planning, which handles constraints, with scheduling inside Manufacturing or Planning).
- Integration is through REST and SOAP services, FBDI file import, business events and OIC playbooks.

## 3. Research plan for the remaining Part 3 questions (needed before any Oracle claim in a customer-facing document)

| Priority | Page set | Question it settles |
|---|---|---|
| 1 | Readiness pages for Order Exception Assistant, Sales Order Assistant, Inventory Reservation Assistant, Work Order Completion Assistant, Planning Order Release Assistant, Autonomous Sourcing Assistant | Which ones **execute** transactions, which only recommend, what approval or confirmation step exists |
| 2 | Sales Order Command Center and Production Shift Operations Workspace guides | Role, data shown, actions available from the workspace |
| 3 | Global Order Promising and Supply Planning guides | How promise dates and plan exceptions are computed (deterministic vs. ML) |
| 4 | SCM integration playbooks overview (URL in the brief) | Integration style and the objects exchanged |
| 5 | Architecture Center / Fusion Applications architecture pages (Part 12 references) | Real reference architecture; decide what is applicable at our scale |

Competitors (SAP, Siemens Opcenter, PlanetTogether, Dynamics 365, Epicor, Infor, Odoo, Kinaxis, o9): **not researched.** PlanetTogether and Kinaxis are the most relevant benchmarks for the APS and exception-management claims. Research them before making any claim about scheduling quality.
