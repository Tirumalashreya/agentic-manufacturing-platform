import type { ReactNode } from "react";

// Generalizes the existing .clarify-card pattern (globals.css), previously
// used only for the approval-clarification callout — the same visual
// treatment is real and reusable for any "needs your attention" banner
// (design-system pass, agreed with the user). tone maps to the same
// semantic colors StatusBadge uses.
export type AlertTone = "warning" | "danger" | "info";

const TONE_STYLE: Record<AlertTone, { border: string; background: string }> = {
  warning: { border: "var(--gold)", background: "var(--gold-soft)" },
  danger: { border: "var(--alert)", background: "var(--alert-soft)" },
  info: { border: "var(--accent)", background: "var(--accent-soft)" },
};

export function AlertBanner({
  tone = "warning",
  title,
  children,
}: {
  tone?: AlertTone;
  title: string;
  children?: ReactNode;
}) {
  const style = TONE_STYLE[tone];
  return (
    <div style={{ border: `1.6px solid ${style.border}`, background: style.background, borderRadius: 8, padding: "18px 20px" }}>
      <div className="panel-title" style={{ color: "var(--text)" }}>{title}</div>
      {children && <div style={{ fontSize: 12.5, color: "var(--text-soft)", marginTop: 4 }}>{children}</div>}
    </div>
  );
}
