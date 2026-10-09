// Canonical metadata for every real LangGraph node id (see
// builder.add_node(...) calls in services/agent-orchestrator/app/graph.py —
// confirmed against that file directly, 30 real node ids). Shared by
// agent-console (which needs the category to draw the Agent-vs-Deterministic
// distinction) and trace (which previously had its own, separately-drifted,
// incomplete copy of this same map) so the two pages can't diverge again.
//
// `category` follows this codebase's own standing architectural rule:
// "agent" = the node's real work is an LLM call (or is a thin composition
// of ones directly beneath it); "deterministic" = real calculation/
// transaction/persistence with no LLM involved; "routing" = a pure
// control-flow/clarification node, neither. Getting this right is the
// whole point of the redesign — mislabeling a deterministic node as an
// agent is exactly the "AI theatre" this pass exists to avoid.
export type NodeCategory = "agent" | "deterministic" | "routing" | "human";

export type NodeMeta = {
  icon: string;
  label: string;
  category: NodeCategory;
};

export const NODE_META: Record<string, NodeMeta> = {
  intent: { icon: "🧠", label: "Intent Agent", category: "agent" },
  needs_clarification: { icon: "❓", label: "Needs Clarification", category: "routing" },
  understanding: { icon: "🧠", label: "Request Understanding Agent", category: "agent" },
  reference_resolution: { icon: "🔎", label: "Entity Resolution", category: "deterministic" },
  unclear: { icon: "❓", label: "Unclear — Needs Clarification", category: "routing" },
  unsupported: { icon: "🚫", label: "Unsupported Request", category: "routing" },
  context: { icon: "🔎", label: "Context Agent — ERP Lookup", category: "agent" },
  // Handled specially by buildDisplayStages (split into its real Credit/
  // Stock/APS-Agent/Approval sub-steps) — this entry only matters when the
  // raw node is shown un-split, e.g. on the trace page.
  composed_execution: { icon: "🧩", label: "Sales Order Composition", category: "agent" },
  process: { icon: "📋", label: "Process Decision Agent", category: "agent" },
  pre_sales: { icon: "💬", label: "Pre-Sales — Quotation Agent", category: "agent" },
  direct_sales: { icon: "🧾", label: "Direct Sales — Create Order", category: "deterministic" },
  post_sales: { icon: "↩️", label: "Post-Sales Agent", category: "agent" },
  service: { icon: "🛠️", label: "Service Agent", category: "agent" },
  subscription: { icon: "🔁", label: "Subscription Agent", category: "agent" },
  project: { icon: "🏗️", label: "Project Agent", category: "agent" },
  export: { icon: "🌍", label: "Export Agent", category: "agent" },
  consignment: { icon: "📦", label: "Consignment Agent", category: "agent" },
  financial: { icon: "💰", label: "Financial Agent", category: "agent" },
  credit_check: { icon: "⚙️", label: "Credit Check", category: "deterministic" },
  credit_hold: { icon: "⏸", label: "Credit Hold", category: "routing" },
  fulfillment_decision: { icon: "📦", label: "Fulfillment Agent", category: "agent" },
  mts: { icon: "⚙️", label: "Fulfillment: MTS (From Stock)", category: "deterministic" },
  mto: { icon: "⚙️", label: "Fulfillment: MTO (Make to Order)", category: "deterministic" },
  cto: { icon: "⚙️", label: "Fulfillment: CTO (Configure to Order)", category: "deterministic" },
  hybrid: { icon: "⚙️", label: "Fulfillment: Hybrid", category: "deterministic" },
  third_party: { icon: "⚙️", label: "Fulfillment: Third-Party Sourcing", category: "deterministic" },
  unfulfillable: { icon: "🚫", label: "Unfulfillable", category: "routing" },
  not_implemented: { icon: "🚫", label: "Not Implemented", category: "routing" },
  // Phase 8 additions — previously missing from both this app's node maps
  // entirely, so a real, already-shipped capability silently fell back to
  // its raw node id wherever it ran.
  reschedule_request: { icon: "🏭", label: "APS Agent — Reschedule / Optimize", category: "agent" },
  inventory_quality_request: { icon: "📦", label: "Inventory / Quality Agent", category: "agent" },
  // Phase 10/11 — the bounded capability-selection/scenario-comparison
  // reasoning loop (promise_reasoning_node) and its disruption-recovery
  // counterpart (same function, a different goal_type — see graph.py).
  // Genuinely agent work (LLM-driven capability selection + recommendation
  // over deterministic facts), not deterministic calculation — mislabeling
  // it the other way (as this map's own fallback default would, before
  // this entry existed) is exactly the "AI theatre" miscategorization this
  // file's own header warns against.
  promise_reasoning: { icon: "🧭", label: "Promise Reasoning Agent", category: "agent" },
  promise_reasoning_recovery: { icon: "🧭", label: "Promise Recovery Reasoning Agent", category: "agent" },
};

export function nodeMeta(nodeId: string): NodeMeta {
  return NODE_META[nodeId] ?? { icon: "⚙️", label: nodeId, category: "deterministic" };
}
