import type { ReactNode } from "react";

// Wraps the existing .doc-header/.doc-kicker/.doc-title/.doc-desc classes
// (globals.css) — every page currently hand-writes this markup itself with
// no shared component (design-system pass, agreed with the user). Zero new
// CSS; this only gives the existing pattern one real implementation.
export function PageHeader({
  kicker,
  title,
  description,
  actions,
}: {
  kicker?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="doc-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
      <div>
        {kicker && <div className="doc-kicker">{kicker}</div>}
        <h1 className="doc-title">{title}</h1>
        {description && <p className="doc-desc">{description}</p>}
      </div>
      {actions && <div style={{ flexShrink: 0, display: "flex", gap: 8 }}>{actions}</div>}
    </div>
  );
}
