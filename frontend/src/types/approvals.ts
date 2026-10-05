// Mirrors financial_tools.FINANCIAL_ADJUSTMENT_HEADERS — the only
// approval gate actually wired into the live graph today (see
// graph.py's financial_node PENDING_APPROVAL branch).
export type FinancialAdjustment = {
  financial_adjustment_id: string;
  adjustment_type: string;
  customer_id: string | null;
  customer_name: string | null;
  reference: string | null;
  amount: number;
  reason: string;
  approval_required: boolean;
  approved_by: string | null;
  approved_at: string | null;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "POSTED";
  created_at: string;
  posted_at: string | null;
};
