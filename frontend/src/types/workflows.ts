// Mirrors app/routers/workflows.py's normalized shape — one row per
// in-progress entity across every domain that has a real post-creation
// operational step (Financial Adjustments are covered by the Approvals
// page instead; Subscriptions have no pending action to queue).
export type ActiveWorkflowDomain =
  | "SALES_ORDER"
  | "PROJECT_MILESTONE"
  | "EXPORT_ORDER"
  | "CONSIGNMENT"
  | "SERVICE_ORDER"
  | "RETURN"
  | "TRADING_ORDER";

export type ActiveWorkflowItem = {
  domain: ActiveWorkflowDomain;
  id: string;
  status: string;
  customer_name: string | null;
  summary: string;
  amount: number | null;
  created_at: string | null;
};
