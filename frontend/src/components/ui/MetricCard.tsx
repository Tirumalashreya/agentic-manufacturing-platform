import type { ReactNode } from "react";
import type { StatusTone } from "./StatusBadge";

// Phase 18 (Frontend UX & Visual Polish) — real gap found: every summary
// tile across this app (Promise Inbox's Breached/At-risk/Awaiting-
// approval/Restored counts included) rendered in the same neutral ink
// regardless of what the number actually means, so a planner had to read
// the label to tell a count of breached promises apart from a count of
// verified-safe ones. Optional and additive — `tone` defaults to the
// existing neutral look, so every current call site is unaffected until
// it opts in. Same four tones StatusBadge already uses, for the same
// semantic colors (never color alone — the label text is still what
// actually says what the number means).
const TONE_COLOR: Record<StatusTone, string> = {
  success: "var(--money)",
  warning: "var(--gold)",
  danger: "var(--alert)",
  neutral: "var(--text)",
};

// Wraps the existing .kv/.kv-label/.kv-value/.kv-note classes (globals.css)
// — the small stat-card pattern used inside kv-grid layouts across several
// pages, previously hand-written per call site (design-system pass, agreed
// with the user).
export function MetricCard({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: StatusTone }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className="kv-value" style={tone ? { color: TONE_COLOR[tone] } : undefined}>
        {value}
      </div>
      {note && <div className="kv-note">{note}</div>}
    </div>
  );
}

// Wraps .kv-grid — the grid container MetricCards are meant to sit inside.
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="kv-grid">{children}</div>;
}
