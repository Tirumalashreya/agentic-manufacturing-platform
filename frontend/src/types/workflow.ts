// Loosely typed on purpose — this mirrors the LangGraph SalesState dict
// returned by /pipeline/runs, which varies by entry_type (a DIRECT_SALES
// result has sales_order_id/fulfillment_strategy; a PROJECT result has
// project_id/milestones; etc). Known fields are typed for the ones the
// UI actually reads; everything else still round-trips through
// [key: string]: unknown.
// One entry per LangGraph node that actually ran, in execution order —
// straight from graph.astream(..., stream_mode="updates"), not a guess
// reconstructed from the final merged state. The sequence of `node`
// values IS the routing decision (which conditional edge fired at each
// branch point); `output` is exactly what that node added to state.
export type WorkflowStage = {
  node: string;
  output: Record<string, unknown>;
};

export type WorkflowResult = {
  run_id: string | null;
  user_message: string;
  stages?: WorkflowStage[];

  needs_clarification?: boolean;
  clarification_question?: string | null;

  entry_type?: string;
  process?: string;
  process_reasoning?: string;
  status?: string;
  response?: string;

  // Raw values as the Intent Agent heard them — kept distinct from the
  // resolved customer_name/product_name below so the UI can show "you
  // said X, but that didn't match anything real" instead of just going
  // quiet when resolution fails.
  customer?: string | null;
  product?: string | null;

  customer_id?: string | null;
  customer_name?: string | null;
  customer_exists?: boolean;
  product_id?: string | null;
  product_valid?: boolean;

  // Direct Sales / fulfillment
  sales_order_id?: string | null;
  sales_order_status?: string;
  credit_checked?: boolean;
  credit_within_limit?: boolean;
  credit_existing_exposure?: number | null;
  credit_total_exposure?: number | null;
  fulfillment_strategy?: string;
  fulfillment_reasoning?: string;
  delivery_id?: string | null;
  invoice_id?: string | null;
  invoice_amount?: number | null;

  // Pre-Sales
  quotation_id?: string | null;
  quoted_price?: number | null;

  // Post-Sales
  return_id?: string | null;
  credit_memo_id?: string | null;
  debit_memo_id?: string | null;

  // Service
  service_order_id?: string | null;

  // Subscription
  subscription_id?: string | null;

  // Project
  project_id?: string | null;

  // Export
  export_order_id?: string | null;

  // Consignment
  consignment_id?: string | null;

  // Financial
  financial_adjustment_id?: string | null;

  // The human-approval gate (composed_execution_node) — present only
  // when status is "AWAITING_APPROVAL". `context` is echoed back
  // verbatim to /approvals/sales-order/resolve; nothing is re-derived
  // client-side.
  pending_approval?: {
    action: string;
    context: Record<string, unknown>;
    preview: {
      customer_name: string | null;
      product_name: string | null;
      quantity: number | null;
      unit_price: number | null;
      estimated_value: number;
      credit_within_limit: boolean | null;
      stock_sufficient: boolean | null;
      // Only ever true for a genuine zero-stock, producible, non-configurable
      // item with a real vendor on file — see composed_execution_node.
      vendor_available?: boolean;
      vendor_names?: string[];

      // Planning-before-approval (agreed with the user): fulfillment
      // strategy, and — for MTO/CTO/HYBRID/THIRD_PARTY — the real
      // production or vendor plan, decided BEFORE the human approves,
      // not after. See composed_execution_node.
      fulfillment?: {
        strategy: string;
        reasoning: string;
        from_stock: number;
        to_produce: number;
      } | null;
      // Only present for MTO/CTO/HYBRID's production leg — the real plan
      // from the manufacturing services (order-service/routing-service/
      // machine-service/inventory-service/scheduling-service), not
      // fabricated.
      //
      // Phase 2 (agreed with the user) — verdict split what used to be one
      // word ("UNPLANNABLE") into the real distinct causes:
      //   PLANNING_CONFIGURATION_ISSUE — no BOM/routing/master-data
      //     mapping exists at all. A real config gap, blocks approval.
      //   WAITING_FOR_PRODUCTION_SLOT — every operation IS placed, just
      //     only after the scheduler's own bounded extended-horizon retry
      //     (see scheduling-service's EXTENDED_HORIZON_DAYS). A real,
      //     complete plan — does NOT block approval.
      //   PLANNER_REVIEW — the scheduler tried the extended horizon too
      //     and still couldn't place every operation. Blocks approval.
      production_plan?: {
        verdict: "PASS" | "WARNING" | "MATERIAL_SHORTAGE" | "PLANNING_CONFIGURATION_ISSUE" | "WAITING_FOR_PRODUCTION_SLOT" | "PLANNER_REVIEW";
        explanation: string;
        materials: { component_name: string; required: number; available: number; shortage: number }[];
        routing_operations: { operation: string; op_number: number; work_center_code: string }[];
        simulated_operations: { operation: string; machine_name: string; scheduled_start: string; scheduled_end: string; via_extended_horizon?: boolean }[];
        production_order_id: string | null;
        // Real vendor/quantity/lead-time suggestion for any shortfall —
        // approving now also places these purchase orders for real (see
        // SalesOrderApprovalResult.purchase_orders below).
        procurement_plan: {
          component_name: string;
          quantity: number;
          vendor_name: string;
          lead_time_days: number;
          expected_date: string;
        }[];
      } | null;
      // Only present for THIRD_PARTY/TRADING's vendor pick.
      vendor_plan?: {
        vendors_available: boolean;
        vendor_name?: string;
        strategy_label?: "THIRD_PARTY" | "TRADING";
        reasoning?: string;
        lead_time_days?: number;
        target_completion_date?: string;
      } | null;

      // Reschedule/Optimize's own pending_approval variant (agreed with
      // the user) — present only when pending_approval.action is
      // "RESCHEDULE_PRODUCTION" (a conversational "reschedule SO-1045" /
      // "optimize SO-1045" request), never alongside the order-creation
      // fields above. Real, non-fabricated: affected_order_ids comes
      // straight from scheduling-service's own resolveScopedOrderIds(),
      // the exact same resolution the committing run itself uses.
      sales_order_id?: string;
      kind?: "reschedule" | "optimize";
      scope?: "SINGLE" | "AFFECTED";
      mode?: string;
      target_order_id?: string;
      affected_order_ids?: string[];
      affected_count?: number;
    };
  };

  [key: string]: unknown;
};

export type SalesOrderApprovalResult = {
  resolved: boolean;
  status: string;
  created: boolean;
  sales_order_id?: string;
  sales_order_status?: string;
  sales_order_total?: number;
  // What happens after creation — an approved order now continues into
  // the real fulfillment decision (MTS/MTO/CTO/HYBRID/THIRD_PARTY) and,
  // where that completes synchronously, a real delivery + invoice.
  fulfillment_strategy?: string | null;
  fulfillment_reasoning?: string | null;
  fulfillment_status?: string | null;
  fulfillment_note?: string | null;
  delivery_id?: string | null;
  delivery_status?: string | null;
  confirmed_delivery_date?: string | null;
  invoice_id?: string | null;
  invoice_status?: string | null;
  invoice_amount?: number | null;
  // Real, persisted ScheduledOperation rows from scheduling-service, only
  // present once a production plan was actually committed (post-approval).
  production_order_id?: string | null;
  scheduled_operations?: { routingOperationId: string; machineId: string; scheduledStart: string; scheduledEnd: string }[] | null;
  purchase_orders?: { purchase_order_id: string; component_name: string; quantity: number; vendor_name: string; expected_date: string }[] | null;
};

export type TimelineStepState = "done" | "current" | "blocked" | "pending";

export type TimelineStep = {
  label: string;
  state: TimelineStepState;
  detail?: string;
};
