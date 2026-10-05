import type { ReactNode } from "react";

// Wraps the existing .kv/.kv-label/.kv-value/.kv-note classes (globals.css)
// — the small stat-card pattern used inside kv-grid layouts across several
// pages, previously hand-written per call site (design-system pass, agreed
// with the user).
export function MetricCard({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
      {note && <div className="kv-note">{note}</div>}
    </div>
  );
}

// Wraps .kv-grid — the grid container MetricCards are meant to sit inside.
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="kv-grid">{children}</div>;
}
