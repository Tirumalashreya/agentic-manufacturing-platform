"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  code: string;
  label: string;
  href?: string; // omit for not-yet-built items
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

// Structure matches the target sidebar from the Ledger design brief.
// Only items with an `href` are real routes for this milestone — the
// rest are shown, not hidden, so the intended shape of the app is
// visible, but marked SOON rather than wired to a dead link.
const NAV_GROUPS: NavGroup[] = [
  {
    label: "OVERVIEW",
    items: [{ code: "—", label: "Dashboard", href: "/" }],
  },
  {
    label: "WORK",
    items: [
      { code: "NEW", label: "New Request", href: "/request" },
      { code: "WFL", label: "Active Workflows" },
      { code: "APR", label: "Approvals" },
    ],
  },
  {
    label: "BUSINESS FLOWS",
    items: [
      { code: "DOM·01", label: "Domestic Sales" },
      { code: "EXP·02", label: "Export Sales" },
      { code: "SVC·03", label: "Services Sales" },
      { code: "RET·04", label: "Returns" },
      { code: "CON·05", label: "Consignment Sales" },
      { code: "PRJ·06", label: "Project Sales" },
      { code: "TRD·07", label: "Trading" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { code: "ERP", label: "ERP Connection" },
      { code: "AUD", label: "Audit Trail" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside id="sidebar">
      <div className="brand">
        <div className="brand-mark">Ledger</div>
        <div className="brand-sub">SALES OPERATIONS CONSOLE</div>
      </div>
      <nav id="navlist">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item) =>
              item.href ? (
                <Link
                  key={item.label}
                  href={item.href}
                  className={`nav-item${pathname === item.href ? " active" : ""}`}
                >
                  <span className="nav-code">{item.code}</span>
                  <span>{item.label}</span>
                </Link>
              ) : (
                <div key={item.label} className="nav-item disabled">
                  <span className="nav-code">{item.code}</span>
                  <span>{item.label}</span>
                  <span className="nav-soon">SOON</span>
                </div>
              )
            )}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        v0.1 PROTOTYPE
        <br />
        live vertical slice
      </div>
    </aside>
  );
}
