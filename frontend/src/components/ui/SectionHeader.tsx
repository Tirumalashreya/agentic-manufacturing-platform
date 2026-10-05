import type { ReactNode } from "react";

// A smaller heading than PageHeader, for a sub-section inside a page (e.g.
// "Production" within an Order Control Center) — new, consistent pattern
// (design-system pass, agreed with the user).
export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 700, color: "var(--text)", margin: 0 }}>
        {title}
      </h2>
      {actions}
    </div>
  );
}
