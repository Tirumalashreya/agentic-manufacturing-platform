"use client";

// The reference mockup has no shell bar at all — just a sidebar and
// content. A top app bar (search, notifications, user) sitting above a
// slimmer side nav is the actual Fiori Launchpad shell shape, and is the
// single biggest structural tell that this isn't the same layout wearing
// new colors.
export function TopBar() {
  return (
    <header id="topbar">
      <div id="topbar-left">
        <span id="topbar-grid">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span id="topbar-title">Ledger</span>
      </div>
      <div id="topbar-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input placeholder="Search orders, customers, records…" />
      </div>
      <div id="topbar-right">
        <button type="button" id="topbar-icon-btn" aria-label="Notifications">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
        <div id="topbar-avatar">SO</div>
      </div>
    </header>
  );
}
