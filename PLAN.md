# Agentic ERP Sales Workflow — Final Architecture

Supersedes the earlier Demand→Analytics-first plan. That 12-agent production
pipeline isn't discarded — it's reused *inside* this one, specifically inside
the Fulfillment → Production Planning branch (MTO/CTO/Hybrid paths), entered
partway through (no Demand/S&OP forecasting needed once a real Sales Order
exists).

Infra already built and proven working, still valid: Python `agent-orchestrator`
service (FastAPI + LangGraph + Groq), its own database (`aps_platform_agentic`),
`AgentPipelineRun`/`AgentStageResult` logging tables, full chain tested live
once already (API → agent → Groq → validated → logged to Postgres).

## Core rule

- **Agents** (reason/decide): Intent, Context, Process Decision, Quotation,
  Fulfillment, Billing, Post-Sales, Exception, Summary
- **Routers** (deterministic LangGraph conditional nodes, not LLM calls):
  Entry Router, Fulfillment Router
- **Stages** (business/data states, not agents): Lead, Inquiry, Quotation,
  Sales Order, Delivery, Billing, Payment
- **Tools** (deterministic functions, ERP reads/writes): `check_inventory()`,
  `create_sales_order()`, `get_bom()`, `create_invoice()`, etc. — LLMs never
  mutate ERP state directly, only through typed tools.

## Top-level flow

```
USER → Intent Agent → Context Agent → Process Decision Agent → Entry Router
  → [PRE_SALES | DIRECT_SALES | POST_SALES | SUBSCRIPTION | SERVICE | PROJECT | FINANCIAL]
  → Sales Order (if applicable)
  → Fulfillment Agent → Fulfillment Router
  → [MTS | MTO | CTO | THIRD_PARTY | INTERCOMPANY | HYBRID]
  → Production Planning (BOM → materials → procurement → production), if manufacturing needed
  → Delivery/Service/Milestone → Billing → Payment → Complete
```

Hybrid/split fulfillment is real (e.g. need 100, have 40 in stock → 40 from
stock + 60 from production, in parallel).

## Directory structure

```
app/
├── agents/        intent_agent.py, context_agent.py, process_agent.py,
│                  quotation_agent.py, fulfillment_agent.py, billing_agent.py,
│                  post_sales_agent.py, exception_agent.py, summary_agent.py
├── schemas/       state.py (shared SalesState), intent.py, process.py,
│                  fulfillment.py, results.py
├── routers/       pipeline.py (FastAPI entry point)
├── tools/         customer_tools.py, product_tools.py, inventory_tools.py,
│                  sales_tools.py, production_tools.py, procurement_tools.py,
│                  delivery_tools.py, billing_tools.py
├── workflows/     pre_sales.py, direct_sales.py, post_sales.py,
│                  fulfillment.py, production_planning.py, subscription.py,
│                  service.py, project.py
├── db.py, graph.py, main.py
```

`tools/` and `workflows/` are new — can start as plain functions inside
`graph.py` for the smallest MVP, split out once there's enough code to
justify the separate files.

## Build order (do not build everything at once)

1. `schemas/state.py` — shared LangGraph state
2. Intent Agent
3. Context Agent (mock ERP tools first)
4. Process Decision Agent (structured output)
5. Deterministic Entry Router
6. Pre-Sales workflow: Lead → Inquiry → Quotation → Sales Order
7. Direct Sales workflow (D2C/Cash/direct order)
8. Fulfillment Agent + Fulfillment Router
9. MTS + Hybrid fulfillment first
10. Production Planning: BOM → material availability → procurement → production
11. Billing + Summary events
12. Connect Next.js dashboard to workflow events
13. Approval / pause-resume
14. MTO, CTO, Third Party, Intercompany
15. Post-Sales: Return → Credit Memo, then Debit Memo
16. Subscription, Service, Project workflows
17. Replace mock ERP tools with real adapters last, once the model is stable

## Safety rules carried over from earlier design work this session

- Agents propose, tools execute — never let an LLM directly mutate committed
  data (same principle as the Excel importer's propose→confirm split from `r`).
- Every stage/agent call gets logged (`AgentPipelineRun`/`AgentStageResult`,
  already built and proven working) — unconditional, not gated on approval.
- Approval gates are for real-consequence actions (large discount, large
  credit memo, high-value PO) — not blanket-applied to every step.
- Single-shot structured output by default; ReAct only for agents that
  genuinely need multi-step tool reasoning (the same rule from the earlier
  design still applies here, e.g. Context Agent gathering several related
  facts before deciding what's missing).
