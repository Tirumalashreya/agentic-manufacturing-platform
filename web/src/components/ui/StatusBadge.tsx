import { cn } from "@/lib/cn";

// New — distinct from Badge.tsx (which is always brand-colored, used for
// counts/labels). This is specifically for semantic status (design-system
// pass, agreed with the user) — previously every page picked raw Tailwind
// colors ad hoc per call site (e.g. "border-red-300 bg-red-50 text-red-700"
// repeated independently in Recovery, Production Planning, Materials...).
// Wires those same visual choices to the new named tokens instead, so a
// future palette change is one file, not a grep-and-replace.
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
  danger: "border-danger/30 bg-danger-soft text-danger",
  info: "border-info/30 bg-info-soft text-info",
  neutral: "border-border bg-surface-muted text-muted",
};

export function StatusBadge({ tone, className, children }: { tone: StatusTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}
