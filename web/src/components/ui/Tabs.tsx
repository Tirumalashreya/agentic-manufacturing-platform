"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

// New — no tabbed interface exists anywhere in APS Platform today
// (design-system pass, agreed with the user).
export function Tabs({ tabs, defaultTab }: { tabs: { key: string; label: string; content: ReactNode }[]; defaultTab?: string }) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.key);
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-sm font-medium",
              tab.key === active ? "border-brand-500 text-foreground" : "border-transparent text-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab?.content}
    </div>
  );
}
