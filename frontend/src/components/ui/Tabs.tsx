"use client";

import { useState, type ReactNode } from "react";

// New shared component (design-system pass, agreed with the user) — no
// tabbed interface exists anywhere in Ledger today; this is what lets the
// Sales Orders page group its 7 real channels under one destination
// (channel-as-tab) instead of 7 separate top-level nav items, per the
// approved IA.
export function Tabs({
  tabs,
  defaultTab,
}: {
  tabs: { key: string; label: string; content: ReactNode }[];
  defaultTab?: string;
}) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key);
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", marginBottom: 16 }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            style={{
              padding: "8px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              background: "none",
              border: "none",
              borderBottom: `2px solid ${tab.key === active ? "var(--accent)" : "transparent"}`,
              color: tab.key === active ? "var(--text)" : "var(--text-faint)",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab?.content}
    </div>
  );
}
