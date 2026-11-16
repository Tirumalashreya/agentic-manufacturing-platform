# Oracle capabilities: agent / predictive / deterministic / agentic app

Source: the Oracle SCM AI feature index (see [oracle_scm_product_reverse_engineering.md](oracle_scm_product_reverse_engineering.md)). That page gives **type labels only**. Autonomy, approval and determinism below are therefore marked as either *labeled by Oracle* or *our reading*. Nothing here asserts how an Oracle agent behaves at runtime.

## Oracle's own taxonomy (VERIFIED, from the index)

| Oracle label | Meaning as used on the page | Examples |
|---|---|---|
| AI agent | A single-purpose assistant embedded in a module, usually named "Assistant", "Advisor" or "Guide" | Order Exception Assistant, Work Order Completion Assistant, Planning Order Release Assistant |
| Agentic app | A role workspace ("Command Center", "Workspace") that hosts several agents/advisors | Sales Order Command Center, Production Shift Operations Workspace, Sourcing Command Center |
| Predictive AI | Embedded ML | Product classification code proposal, planned shipment ETA, order route prediction, predictive slotting |
| Fusion Claw | Undefined on the page (4 items, all 26D) | Procurement Spend Command Center, Supply Planning Allocation Workspace |

## Our reading by capability class (HYPOTHESIS until per-feature pages are read)

| Capability class | Likely deterministic core (not an agent) | Agent role (our reading) | Evidence strength |
|---|---|---|---|
| Order promising, ATP/CTP | Promise computation | Explain, recommend alternatives | Low: not read |
| Order exceptions | Exception detection | Triage, suggest recovery, draft corrections | Medium: the name and the 25D-to-26C enhancement sequence ("Improve responses, extensions, exceptions, and recovery") |
| Inventory reservation / shortages | Reservation and stock accounting | Recommend reservations ("View Proactive Recommendations", 26C) | Low |
| Work order completion / sync | Completion transaction | Guide data entry, sync assist | Low |
| Production scheduling | Planning/scheduling engine | Absent from the AI index as an agent | Medium (absence in the index) |
| Sourcing | Award math | "Autonomous Sourcing Assistant" is the only name implying autonomy; **degree unknown** | Low |
| ETA, route, slotting | n/a | Predictive ML, not LLM agents | Medium (labeled Predictive AI) |

## What this means for us (design implications, not claims about Oracle)

1. A one-agent-per-narrow-task, plus-workspace shape is the market pattern. It matches our direction of verdict-writer agents plus a command-center UI, and does not argue for more agents.
2. Because the index does not describe autonomy, **our product must not market "more autonomous than Oracle"**. We cannot show it, and our own principle (humans approve consequential actions) points the other way.
3. Predictive AI is correctly separated by Oracle from LLM agents. We should do the same: ETA, delay and shortage risk should be statistical models or deterministic rules, not LLM calls.

Next step to turn hypotheses into findings: read the readiness page for the six priority features listed in the reverse-engineering doc, section 3.
