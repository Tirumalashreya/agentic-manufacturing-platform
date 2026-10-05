import type { StatusTone } from "./StatusBadge";

// New — a page-level "needs your attention" banner (design-system pass,
// agreed with the user), same semantic tones as StatusBadge. Distinct from
// Modal (an interruption) — this sits inline in the page flow.
const TONE_CLASS: Record<Extract<StatusTone, "warning" | "danger" | "info">, string> = {
  warning: "border-warning bg-warning-soft",
  danger: "border-danger bg-danger-soft",
  info: "border-info bg-info-soft",
};

export function AlertBanner({
  tone = "warning",
  title,
  children,
}: {
  tone?: "warning" | "danger" | "info";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${TONE_CLASS[tone]}`}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children && <div className="mt-1 text-xs text-muted">{children}</div>}
    </div>
  );
}
