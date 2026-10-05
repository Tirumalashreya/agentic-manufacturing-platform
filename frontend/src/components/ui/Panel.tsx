import type { ReactNode } from "react";

// Wraps the existing .panel/.panel-title/.panel-sub classes (globals.css) —
// every page currently writes <div className="panel"> by hand with no
// shared component (design-system pass, agreed with the user).
export function Panel({
  title,
  subtitle,
  actions,
  children,
  style,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="panel" style={style}>
      {(title || actions) && (
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            {title && <div className="panel-title">{title}</div>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
