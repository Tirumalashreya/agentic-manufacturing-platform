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

## Business-layer freeze (2026-09-05)

All 10 entry_type workflows from the Core rule above are built, wired,
and tested: PRE_SALES, DIRECT_SALES, POST_SALES, SERVICE, SUBSCRIPTION,
PROJECT, EXPORT, CONSIGNMENT, FINANCIAL — plus Trading as a real
fulfillment strategy under DIRECT_SALES (not a separate top-level
entry_type; a customer never directly asks for "a Trading" the way they
ask for "a Project", it's an internal sourcing decision, correctly
modeled next to MTS/MTO/CTO/HYBRID).

This is a deliberate stopping point for business-workflow scope. Adding
an 11th workflow, or reshaping these 10 for a "cleaner" architecture with
no evidenced duplication or blocked capability behind it, is out of scope
until one is actually needed — not a checklist item to clear.

### What's real business logic (survives a persistence/ERP swap)

- Every validation rule: credit exposure checks, return eligibility
  windows, customer/product/quantity cross-checks on post-sales actions,
  milestone/retention math, consignment sell-through accounting,
  financial approval gating.
- The agents-propose/tools-execute split — no LLM ever mutates committed
  data directly, only through a typed tool.
- The "chat graph creates the initial commitment; every operational event
  after that (inspection, dispatch, milestone sign-off, shipment,
  consignment sale reporting, financial approval) is a directly-callable
  function, not another chat turn" pattern, applied consistently across
  Post-Sales, Trading, Service, Project, Export, Consignment, Financial.
- The narrow, observed-not-speculative retry wrapper for Groq's gpt-oss
  tool-calling flake (see `services/agent-orchestrator/challenge.md`).

### What's intentionally mock/simplified (real work needed before production)

- **Persistence**: a single `mock_erp.xlsx` opened and rewritten wholesale
  on every read and write. No transactions, no row-level locking, no
  concurrency control — two simultaneous writes to the same sheet can
  race and silently lose an update. Fine for one test run or a demo; not
  safe for concurrent real users.
- **Payments**: `mark_invoice_paid()` is the only payment-tracking
  capability in the system, and it's a flag flip — no real bank/payment
  gateway integration, no reconciliation. Credit exposure sums *every*
  confirmed order forever with no netting against payment (documented in
  `credit_tools.py`).
- **Export compliance**: LC/payment verification, customs declarations,
  freight bookings, and BL/AWB numbers are free-text references recorded
  as given — no real bank, customs, or freight-carrier integration
  behind any of them.
- **Production completion**: nothing in this system ever marks a
  Production Order complete — MTO/CTO/Project/Export production orders
  reach IN_PRODUCTION and stay there. A real completion signal (and the
  delivery/billing that should follow it) doesn't exist yet.
- **Policy constants**: Project's 30/40/30 milestone split and 10%
  retention, Financial's 50,000 approval threshold, the 30-day return
  window, Net 30 terms — all flat, global constants, not
  per-customer/per-contract configuration. Deliberate (no evidenced need
  for variation yet), but a real system would need these configurable.
- **No auth/RBAC**: any caller can resolve any approval, inspection, or
  financial sign-off as any identity string they choose — there's no real
  concept of who is allowed to do what.
- **LLM reliability**: Groq's gpt-oss-120b tool-calling is genuinely
  flaky under `with_structured_output` (see challenge.md) — the retry
  wrapper handles the common case, but a bad-enough run can still exhaust
  5 attempts and surface an error to the caller. No circuit breaker or
  fallback model exists.

### Architecture review: common-service extraction and the persistence boundary (deferred, not skipped)

Looked for real, evidenced duplication before touching anything, per the
"only extract what's actually repeated, only if it removes real
duplication or enables a real next capability" rule.

**Found**: every tools file re-implements the same handful of mechanical
openpyxl patterns — get-or-create a sheet with headers, find the max
numeric ID suffix for a prefix, find a row by id and zip it against
headers, set a handful of fields on a matched row. This is real,
extensively repeated (12+ near-identical copies across
post_sales_tools/service_tools/trading_tools/project_tools/
export_tools/consignment_tools/financial_tools and the pre-existing
files), not imagined.

**Decision: defer the extraction anyway.** Deduplicating these now, with
only one backend (Excel) that will ever exist until a real PostgreSQL
migration actually happens, buys DRY-ness but not a new capability —
the roadmap's own "Initially: ExcelRepository. Then later:
PostgresRepository. Your workflow shouldn't care" only pays off once a
second real implementation exists to justify the interface. Extracting
the seam today, before that second implementation is real, is the same
premature-abstraction trap being deliberately avoided elsewhere. The
right trigger to actually do this is: starting real Postgres migration
work. At that point the same 4 primitives (get-or-create-sheet, next-id,
find-by-id, set-fields) become an `ExcelRepository` + a real
`PostgresRepository` behind one small interface — not a moment before,
and not a large generic repository framework even then.

Not deferred: **CustomerService/ProductService/... class wrappers** as
literally described in the original roadmap. The existing
`*_tools.py` module-per-domain split already IS that separation — the
roadmap's own diagrams (Project/Export/Trading all calling into shared
Production/Procurement/Billing capabilities) already describe what this
codebase does today with plain functions. Wrapping working, tested
functions in classes for no behavioral reason is not planned at all,
deferred or otherwise.

### Reliability additions (idempotency, audit — checkpointing skipped)

- **Idempotency** (`app/tools/idempotency_tools.py`): a single
  key/operation → prior-result lookup, wired only into the operations a
  retry could genuinely double-create — `create_sales_order`,
  `create_purchase_order`, `create_delivery`, `create_invoice`,
  `process_post_sales_action`, `create_financial_adjustment` — via an
  optional `idempotency_key` param, fully backward-compatible (omit it,
  nothing changes).
- **Audit/event history** (`app/tools/audit_tools.py`): one shared
  append-only `AuditEvents` log, wired into every real status transition
  across Project/Export/Trading/Service/Consignment/Financial/Post-Sales
  — the multi-stage entities where "record PROJECT_CREATED,
  MILESTONE_SIGNED_OFF, ..." instead of just `status = X` actually gives
  someone a real timeline.
- **LangGraph checkpointing: deliberately not added.** No node in this
  graph ever calls `interrupt()`, and the compiled graph has no
  checkpointer. Every multi-stage, human-involved process already
  progresses through directly-callable operational functions outside the
  graph (the same pattern used throughout), which does the pause/resume
  job checkpointing would otherwise exist for. Adding a checkpointer now
  would be infrastructure with nothing that actually uses it.

### ERP adapter interface (`app/erp/`)

Built the interface the roadmap's Phase 15 asks for, scoped to what
"the smallest ERP adapter interface based on operations the existing
workflows actually use" actually means once you look at what's real:
**not every function in `app/tools/`** — only the operations a real
external ERP (SAP/Oracle/Dynamics) would actually be the system of
record for. Customer/product/vendor master data, inventory levels, and
the core transactional documents (Sales Order, Purchase Order, Delivery,
Invoice, Production Order) are ERP-owned concepts. A Project Milestone,
an Export customs declaration, a Consignment's sell-through ledger, a
Financial Adjustment's approval state — these are business-process state
this system itself invented; no real ERP has a native concept of them,
so they stay owned by this system's own tables regardless of which ERP
sits behind the rest, and are deliberately NOT part of this interface.

`ERPAdapter` (`app/erp/interface.py`) defines exactly 14 methods on that
basis. `MockERPAdapter` (`app/erp/mock_erp_adapter.py`) is the only
implementation today — a pure, behavior-preserving delegate to the
existing `tools/*.py` functions, proven identical via
`test_erp_adapter.py`. It's wired in for real, not decorative:
`context_agent.py` and the entire `graph.py` DIRECT_SALES/fulfillment
pipeline (credit check, MTS/MTO/CTO/HYBRID/THIRD_PARTY, delivery,
billing, procurement) now calls through `erp.*` instead of importing the
tool functions directly. Service/Project/Export/Consignment/Financial's
own internal calls to these same underlying functions were deliberately
left as direct tool imports for now — extending adapter usage there is a
mechanical follow-up, not blocked on anything, just not done speculatively
ahead of a real second backend needing it.

A second real implementation (`SAPAdapter`, `OracleAdapter`, ...) is what
this interface is actually for — it doesn't exist yet, and picking one
needs a real decision about which ERP and what credentials/environment
are actually available.
