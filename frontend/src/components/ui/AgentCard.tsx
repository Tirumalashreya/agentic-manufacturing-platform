"use client";

import { useState, type ReactNode } from "react";
import type { NodeCategory } from "@/lib/graphNodes";

// Promoted out of agent-console/page.tsx's inline StageCard (design-system
// pass, agreed with the user) — the real Agent/Deterministic/Human-Gate
// category badge and collapsible raw-output pattern built in the previous
// redesign phase, now a real shared component instead of living only
// inside one page. agent-console/page.tsx keeps its own StageCard for now
// (it has extra report-button wiring specific to that page) — this is the
// generic version for any future page that wants the same real pattern.
export type AgentCardStatus = "done" | "paused" | "failed";

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  agent: "LLM",
  deterministic: "Deterministic",
  human: "Human Gate",
  routing: "Routing",
};

export function AgentCard({
  icon,
  label,
  category,
  status,
  decision,
  output,
}: {
  icon: string;
  label: string;
  category: NodeCategory;
  status: AgentCardStatus;
  decision?: ReactNode;
  output?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        border: `1px solid ${status === "paused" ? "var(--gold)" : "var(--line)"}`,
        background: status === "paused" ? "var(--gold-soft)" : "var(--card)",
        borderRadius: 8,
        marginBottom: 10,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!output}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "transparent",
          border: "none",
          cursor: output ? "pointer" : "default",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>
          {label}
          <span
            style={{
              marginLeft: 7,
              fontSize: 9,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              padding: "1px 5px",
              borderRadius: 3,
              border: "1px solid var(--line)",
              color: "var(--text-faint)",
              verticalAlign: "middle",
            }}
          >
            {CATEGORY_LABEL[category]}
          </span>
        </span>
        {decision && (
          <span
            className={`chip ${status === "failed" ? "bad" : status === "paused" ? "warn" : "ok"}`}
            style={{ fontSize: 10.5 }}
          >
            {decision}
          </span>
        )}
        {output && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{open ? "▲" : "▼"}</span>}
      </button>
      {open && output && (
        <pre
          style={{
            margin: 0,
            padding: "10px 14px 12px",
            fontSize: 11,
            borderTop: "1px solid var(--line)",
            overflowX: "auto",
            color: "var(--text-soft)",
          }}
        >
          {JSON.stringify(output, null, 2)}
        </pre>
      )}
    </div>
  );
}
