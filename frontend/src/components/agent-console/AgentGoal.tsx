// Phase 12 — the one reusable "what is this episode trying to achieve"
// header, shared by both Order Promise and Promise Recovery (brief §2:
// one experience, not a separate UI per goal_type). Pure/presentational —
// no fetching, no state.
export function AgentGoal({
  goalType,
  customerName,
  productName,
  quantity,
  requestedDate,
}: {
  goalType: "ORDER_PROMISE" | "PROMISE_RECOVERY";
  customerName?: string | null;
  productName?: string | null;
  quantity?: number | null;
  requestedDate?: string | null;
}) {
  const title = goalType === "PROMISE_RECOVERY" ? "RECOVERY GOAL" : "GOAL";
  const parts = [
    quantity != null && productName ? `${quantity} × ${productName}` : productName,
    customerName ? `for ${customerName}` : null,
    requestedDate ? `by ${requestedDate}` : null,
  ].filter(Boolean);

  return (
    <div data-testid="agent-goal" style={{ marginBottom: 14 }}>
      <div className="kv-label" style={{ marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
        {parts.length > 0 ? parts.join(" ") : "Goal details unavailable"}
      </div>
    </div>
  );
}
