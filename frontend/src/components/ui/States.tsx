import type { ReactNode } from "react";

// New shared patterns (design-system pass, agreed with the user) — every
// page previously wrote its own ad-hoc "Loading…" / "No orders yet." text
// inline, and a real service failure looked identical to a genuinely empty
// list (the exact silent-empty-on-error problem flagged in this session's
// own production-readiness audit). These three make "empty," "loading,"
// and "failed" three distinct, consistently-styled states instead of one
// generic message.

export function EmptyState({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center" }}>
      <p style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-soft)", margin: 0 }}>{title}</p>
      {description && <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "4px 0 0" }}>{description}</p>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description }: { title?: string; description?: ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 18px",
        borderRadius: 8,
        background: "var(--alert-soft)",
        border: "1px solid var(--alert)",
      }}
    >
      <p style={{ fontSize: 13, fontWeight: 700, color: "var(--alert)", margin: 0 }}>⚠ {title}</p>
      {description && <p style={{ fontSize: 12, color: "var(--text-soft)", margin: "4px 0 0" }}>{description}</p>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 12.5, color: "var(--text-faint)" }}>{label}</div>
  );
}
