"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const COLLAPSE_KEY = "ledger-sidebar-collapsed";

type NavItem = {
  code: string;
  label: string;
  href?: string; // omit for not-yet-built items
  // Points at APS Platform, a genuinely different application — Start/
  // Complete/Block and the real Gantt live there now, not here (see the
  // removal of Ledger's own /execution, /operator, and /scheduling:
  // operator actions belong exclusively to the system operators actually
  // have access to).
  external?: boolean;
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
      { code: "AI", label: "Agent Console", href: "/agent-console" },
      { code: "WFL", label: "Active Workflows", href: "/workflows" },
      { code: "PND", label: "Pending Decisions", href: "/pending-decisions" },
      { code: "RSK", label: "Promise Risk Inbox", href: "/promise-inbox" },
      { code: "APR", label: "Approvals", href: "/approvals" },
    ],
  },
  {
    // Renamed from "BUSINESS FLOWS": same content, but the label now says
    // what it actually is — Sales' own receipts, a sibling of
    // Manufacturing's receipts below, not an unlabeled flat list sitting
    // next to it with no stated relationship.
    label: "SALES LEDGER",
    items: [
      { code: "DOM·01", label: "Domestic Sales", href: "/domestic-sales" },
      { code: "EXP·02", label: "Export Sales", href: "/export-sales" },
      { code: "SVC·03", label: "Services Sales", href: "/services-sales" },
      { code: "RET·04", label: "Returns", href: "/returns" },
      { code: "CON·05", label: "Consignment Sales", href: "/consignment-sales" },
      { code: "PRJ·06", label: "Project Sales", href: "/project-sales" },
      { code: "TRD·07", label: "Trading", href: "/trading" },
      { code: "BIL·08", label: "Billing", href: "/billing" },
    ],
  },
  {
    // No external links to APS Platform sitting here anymore (removed,
    // agreed with the user) — a Sales Order's own real Schedule/APS
    // Status now live inside its detail page (see /domestic-sales/[id]),
    // so a generic "Schedule" link pointing out of Ledger is a leftover
    // doorway from before that page existed. "My Jobs" was worse — a
    // sales user could click straight onto the operator-only app from
    // their own nav, which undercuts the access boundary on purpose kept
    // elsewhere. Operators reach APS Platform directly now, not through
    // a link in the Sales team's own sidebar.
    label: "MANUFACTURING",
    items: [
      { code: "MFG", label: "Overview", href: "/manufacturing" },
      { code: "PP·09", label: "Plan", href: "/production-planning" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { code: "ERP", label: "ERP Connection" },
      { code: "AUD", label: "Audit Trail", href: "/audit" },
      { code: "TRC", label: "Agent Trace", href: "/trace" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  // Real gap found live: a split-screen demo (Agent Console next to the
  // separate Scheduling dashboard) narrows this whole app's window, and
  // the fixed 224px sidebar was eating enough of that width that the
  // actual pipeline content got visibly squeezed. Collapsing to a narrow
  // icon rail gives that space back on demand rather than the sidebar
  // width being fixed regardless of how little room the window has.
  // Starts expanded (matches the server-rendered markup) and only reads
  // the saved preference after mount, so there's no hydration mismatch
  // between what the server sent and what the client first paints.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // ignore — stay expanded for this visit
    }
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore — the toggle still works for this visit
      }
      return next;
    });
  }

  return (
    <aside id="sidebar" className={collapsed ? "collapsed" : undefined}>
      <button
        type="button"
        onClick={toggle}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        style={{
          alignSelf: collapsed ? "center" : "flex-end",
          margin: "10px 10px 0",
          width: 26, height: 26, flex: "none",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: 6, border: "1px solid var(--line)",
          background: "var(--paper-2)", color: "var(--text-faint)",
          cursor: "pointer", fontSize: 12,
        }}
      >
        {collapsed ? "»" : "«"}
      </button>
      <nav id="navlist">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div
                className="nav-group-label"
                title={
                  group.label === "SALES LEDGER"
                    ? "Eight real ways a sale actually happens — proof the AI ran each one correctly, not a menu"
                    : group.label === "MANUFACTURING"
                      ? "A different department's receipts — Plan stays here, Schedule and the operator's queue live on APS Platform"
                      : undefined
                }
              >
                {group.label}
              </div>
            )}
            {group.items.map((item) =>
              item.external && item.href ? (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={collapsed ? `${item.label} (opens APS Platform)` : "Opens APS Platform in a new tab"}
                  className="nav-item"
                >
                  <span className="nav-code">{item.code}</span>
                  {!collapsed && (
                    <>
                      <span>{item.label}</span>
                      <span className="nav-soon" style={{ color: "var(--text-faint)" }}>↗</span>
                    </>
                  )}
                </a>
              ) : item.href ? (
                <Link
                  key={item.label}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={`nav-item${pathname === item.href ? " active" : ""}`}
                >
                  <span className="nav-code">{item.code}</span>
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              ) : (
                <div key={item.label} className="nav-item disabled" title={collapsed ? item.label : undefined}>
                  <span className="nav-code">{item.code}</span>
                  {!collapsed && (
                    <>
                      <span>{item.label}</span>
                      <span className="nav-soon">SOON</span>
                    </>
                  )}
                </div>
              )
            )}
          </div>
        ))}
      </nav>
      {!collapsed && (
        <div className="sidebar-foot">
          v0.1 PROTOTYPE
          <br />
          live vertical slice
        </div>
      )}
    </aside>
  );
}
