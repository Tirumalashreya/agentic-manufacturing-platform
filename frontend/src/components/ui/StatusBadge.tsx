import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "chip ok",
  warning: "chip warn",
  danger: "chip bad",
  neutral: "chip neutral",
};

// Wraps the existing .chip.ok/.warn/.bad/.neutral classes (globals.css) —
// previously every call site picked the class string by hand (design-system
// pass, agreed with the user) — this makes the tone an explicit, typed
// choice instead of a string that has to match a CSS class name exactly.
export function StatusBadge({ tone, className, children }: { tone: StatusTone; className?: string; children: ReactNode }) {
  return <span className={className ? `${TONE_CLASS[tone]} ${className}` : TONE_CLASS[tone]}>{children}</span>;
}
