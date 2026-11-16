# Oracle vs. our product

**Read the limits first.** Oracle's side is based on the AI feature index only (a name/type/release list). Its cells below say what the index shows, not what the feature does. Rows where Oracle's behavior is unknown are marked `?`. Do not quote this in a customer deck without the research in [oracle_scm_product_reverse_engineering.md](oracle_scm_product_reverse_engineering.md) §3.

Labels: **[O-V]** verified Oracle listing, **[O-?]** Oracle behavior not verified, **[OURS-V]** verified in our code, **[NEW]** proposed, **[HYP]** hypothesis needing validation.

## Capability table

| Opportunity | Oracle capability | Our capability | Gap | Proposed improvement | Why it could be better | Difficulty |
|---|---|---|---|---|---|---|
| Order exceptions | Order Exception Assistant, 25D→26C [O-V name]; depth [O-?] | Promise Risk Inbox, `ProductionException`, Late/At-Risk list, ScheduleAuditLog [OURS-V] | Exceptions live on separate screens | One cross-domain exception command center [NEW] | Single workspace for order→plan→machine→material [HYP] | M |
| Order promising | Sales Order Assistant / Command Center [O-V names]; Global Order Promising [O-?] | Deterministic `checkPromiseImpact`, ORDER_PROMISE agent, approval-bound proposals [OURS-V] | Predictive risk model absent | Risk scoring from schedule slack plus supplier/machine history [NEW] | Explainable and replayable [HYP] | M |
| Inventory reservation | Inventory Reservation Assistant (+ proactive recs) [O-V name] | `qtyReserved` counter only [OURS-V] | **No reservation entity** | `StockReservation` ledger with lifecycle [NEW] | Prerequisite for any reservation agent | M |
| Shortages | Inventory Shortages Assistant [O-V name] | Inventory agent verdict-writer, vendor data (memory milestones) [OURS-V] | Supplier lateness not modeled | Shortage forecast from POs and schedule [NEW] | Deterministic first | M |
| Work-order completion | Work Order Completion Assistant [O-V name] | Atomic completion, scrap-aware, FG receipt [OURS-V] | Operator UI is not mobile-first | Mobile operator completion [NEW] | We already own correct semantics | M |
| Quality / rejects | Disposition Assistant for Rejects [O-V name] | Pass/fail inspection and predecessor gate [OURS-V] | No NCR/disposition/rework | Disposition workflow [NEW] | Needed for real shop floor | M-L |
| Scheduling quality | Not shown as agent [O-V absence]; engine [O-?] | Rule-based finite-capacity engine [OURS-V] | **No benchmark** | Benchmark harness first [NEW] | Evidence before claim | M |
| Sequence-dependent setup | Standard in APS class [O-?] | Flat setup per op in pipeline; matrix only in TSP service [OURS-V] | Gap | Use `ChangeoverMatrix` in placement [NEW] | Material for mixed-product lines | L |
| Planning order release | Planning Order Release Assistant [O-V name] | PROMISE_RECOVERY approval path [OURS-V] | No MRP-style planned-order layer | Defer | Low evidence | L |
| Sourcing / procurement | Autonomous Sourcing Assistant, Sourcing Command Center [O-V names] | `VendorProduct` shortage purchasing [OURS-V] | No RFQ/award | **Do not build** now | Out of ERP-for-MTO focus | XL |
| Maintenance | Maintenance Advisor / WO Builder [O-V names] | Breakdown → reschedule chain [OURS-V] | Predictive maintenance absent | Defer | Needs sensor data | L |
| Unified experience | Per-role workspaces inside module boundaries [O-V names] | Two apps: Ledger and APS, no common shell [OURS-V] | Fragmented | Order-lifecycle timeline across both apps [NEW] | Our biggest plausible edge [HYP] | M |
| Reliability engineering | Mature SaaS [O-?] | Idempotency, plant lock, fencing, CAS approvals [OURS-V]; **no outbox/DLQ/metrics** | Large | Foundation work (see roadmap) | Required for pilot | M |

## Where we are at comparable functional level (qualified)

[OURS-V] core order→fulfillment→production→completion lifecycle with real state and tests; approval gating with proposal-hash binding; promise-risk detection; rescheduling scopes. "Comparable" here means *the function exists*. Depth, scale and certification are not comparable and untested.

## Where Oracle is clearly ahead (even without full research)

Breadth (about 260 AI entries across 20 or so modules), enterprise controls, multi-site/multi-entity, localization, security certification, ecosystem. These are not closable by a small team and should not be goals.

## Where we could be different, not necessarily better

1. A single order-to-production timeline and exception inbox (needs user validation).
2. Deterministic, replayable promise recovery with hash-bound approval.
3. Lightweight, fast deployment for mid-size discrete manufacturers (HYP).
