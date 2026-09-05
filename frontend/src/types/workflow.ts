// Loosely typed on purpose — this mirrors the LangGraph SalesState dict
// returned by /pipeline/runs, which varies by entry_type (a DIRECT_SALES
// result has sales_order_id/fulfillment_strategy; a PROJECT result has
// project_id/milestones; etc). Known fields are typed for the ones the
// UI actually reads; everything else still round-trips through
// [key: string]: unknown.
export type WorkflowResult = {
  run_id: string | null;
  user_message: string;

  needs_clarification?: boolean;
  clarification_question?: string | null;

  entry_type?: string;
  process?: string;
  status?: string;
  response?: string;

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

  [key: string]: unknown;
};

export type TimelineStepState = "done" | "current" | "blocked" | "pending";

export type TimelineStep = {
  label: string;
  state: TimelineStepState;
  detail?: string;
};
