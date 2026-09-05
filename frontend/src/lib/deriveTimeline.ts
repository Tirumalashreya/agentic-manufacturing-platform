import type { TimelineStep, WorkflowResult } from "@/types/workflow";

// The backend runs synchronously end-to-end in one request — there's no
// live multi-step stream to follow. This derives a real timeline from
// whichever fields actually came back, per entry_type, rather than
// showing one fixed Direct-Sales-shaped checklist for every workflow.
export function deriveTimeline(result: WorkflowResult): TimelineStep[] {
  const steps: TimelineStep[] = [
    { label: "Request Received", state: "done", detail: result.user_message },
  ];

  const rejected = result.status === "REJECTED" || result.status === "NOT_IMPLEMENTED";

  steps.push({
    label: "ERP Context Resolved",
    state: result.customer_id ? "done" : rejected ? "blocked" : "pending",
    detail: result.customer_id
      ? `${result.customer_name ?? result.customer_id}${result.product_id ? ` · ${result.product_id}` : ""}`
      : result.customer_exists === false
        ? "Customer not found"
        : undefined,
  });

  steps.push({
    label: "Process Decision",
    state: result.entry_type ? "done" : "pending",
    detail: result.entry_type ? `${result.entry_type} · ${result.process ?? ""}` : undefined,
  });

  switch (result.entry_type) {
    case "DIRECT_SALES":
      steps.push(
        { label: "Sales Order", state: result.sales_order_id ? "done" : "blocked", detail: result.sales_order_id ?? result.response },
        { label: "Credit Check", state: result.credit_checked ? "done" : "pending", detail: result.credit_checked ? (result.credit_within_limit ? "Within limit" : "Over limit — on hold") : undefined },
        { label: "Fulfillment", state: result.fulfillment_strategy ? "done" : "pending", detail: result.fulfillment_strategy ? `${result.fulfillment_strategy} — ${result.fulfillment_reasoning ?? ""}` : undefined },
        { label: "Delivery", state: result.delivery_id ? "done" : "pending", detail: (result.delivery_id as string | undefined) ?? undefined },
        { label: "Invoice", state: result.invoice_id ? "done" : "pending", detail: result.invoice_id ? `${result.invoice_id} — ${result.invoice_amount ?? ""}` : undefined }
      );
      break;
    case "PRE_SALES":
      steps.push({ label: "Quotation", state: result.quotation_id ? "done" : "pending", detail: result.quotation_id ? `${result.quotation_id} @ ${result.quoted_price}` : undefined });
      break;
    case "POST_SALES":
      steps.push({
        label: "Post-Sales Action",
        state: result.return_id || result.credit_memo_id || result.debit_memo_id ? "done" : "blocked",
        detail: (result.return_id ?? result.credit_memo_id ?? result.debit_memo_id ?? result.response) as string | undefined,
      });
      if (result.return_id) {
        steps.push({ label: "Inspection", state: result.status === "PENDING_INSPECTION" ? "current" : "pending", detail: result.status });
      }
      break;
    case "SERVICE":
      steps.push({ label: "Service Order", state: result.service_order_id ? "done" : "blocked", detail: (result.service_order_id as string | undefined) ?? result.response });
      break;
    case "SUBSCRIPTION":
      steps.push({ label: "Subscription", state: result.subscription_id ? "done" : "blocked", detail: (result.subscription_id as string | undefined) ?? result.response });
      break;
    case "PROJECT":
      steps.push(
        { label: "Project Awarded", state: result.project_id ? "done" : "blocked", detail: (result.project_id as string | undefined) ?? result.response },
        { label: "Production / Procurement", state: result.status === "IN_EXECUTION" ? "current" : "pending" }
      );
      break;
    case "EXPORT":
      steps.push({ label: "Export Order Confirmed", state: result.export_order_id ? "done" : "blocked", detail: (result.export_order_id as string | undefined) ?? result.response });
      break;
    case "CONSIGNMENT":
      steps.push({ label: "Consignment Created", state: result.consignment_id ? "done" : "blocked", detail: (result.consignment_id as string | undefined) ?? result.response });
      break;
    case "FINANCIAL":
      steps.push({
        label: "Financial Adjustment",
        state: result.financial_adjustment_id ? "done" : "blocked",
        detail: (result.financial_adjustment_id as string | undefined) ?? result.response,
      });
      if (result.financial_adjustment_id) {
        steps.push({ label: result.status === "PENDING_APPROVAL" ? "Awaiting Approval" : "Posted", state: result.status === "PENDING_APPROVAL" ? "current" : "done" });
      }
      break;
    default:
      if (rejected) {
        steps.push({ label: "Outcome", state: "blocked", detail: result.response });
      }
  }

  return steps;
}
