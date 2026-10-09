import type { ReactNode } from "react";

// Generalizes the existing .clarify-card pattern (globals.css), previously
// used only for the approval-clarification callout — the same visual
// treatment is real and reusable for any "needs your attention" banner
// (design-system pass, agreed with the user). tone maps to the same
// semantic colors StatusBadge uses.
export type AlertTone = "warning" | "danger" | "info" | "success";

const TONE_STYLE: Record<AlertTone, { border: string; background: string }> = {
  warning: { border: "var(--gold)", background: "var(--gold-soft)" },
  danger: { border: "var(--alert)", background: "var(--alert-soft)" },
  info: { border: "var(--accent)", background: "var(--accent-soft)" },
  // Phase 12 — the one tone this component didn't have yet: a real
  // positive outcome banner (e.g. "GOAL SATISFIED"), not merely
  // informational. Same --money color StatusBadge's "success" tone and
  // .chip.ok already use, so a success state reads consistently whether
  // it's shown as a banner or a chip.
  success: { border: "var(--money)", background: "var(--money-soft)" },
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
