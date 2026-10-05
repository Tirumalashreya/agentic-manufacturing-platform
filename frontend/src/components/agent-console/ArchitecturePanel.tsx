"use client";

import { useState } from "react";

// Static — real architecture, not per-run data (discoverability pass,
// agreed with the user). Deliberately does not claim every action in the
// system passes through this agent: APS Platform has its own real,
// non-agent-mediated UI for shop-floor operators (Start/Complete/Block,
// Materials, Quality inspection) that calls the same deterministic
// services directly — stated here explicitly rather than implied
// otherwise, since blurring that boundary is the one thing this kind of
// panel most easily gets wrong.
export function ArchitecturePanel() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 6, marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-soft)",
        }}
      >
        <span style={{ flex: 1 }}>ℹ️ How this works</span>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px", fontSize: 11.5, color: "var(--text-soft)", lineHeight: 1.6 }}>
          <pre
            className="mono"
            style={{
              background: "var(--paper-2)",
              padding: "10px 12px",
              borderRadius: 6,
              fontSize: 10.5,
              overflowX: "auto",
              margin: "4px 0 10px",
            }}
          >
{`USER
  ↓
SALES ORDER AGENT  (this console — the only real orchestrator here)
  ↓
  ├─ Intent / Understanding / Context / Fulfillment Agents (LLM)
  ├─ APS Agent → real HTTP call → APS Platform's own deterministic
  │             scheduling/inventory/routing/machine services
  ├─ Inventory Agent / Quality Agent (LLM verdicts over real,
  │             already-computed facts — never invented)
  └─ Human Approval  →  only then does anything commit for real

Postgres · Redis · Kafka underneath all of it`}
          </pre>
          <p style={{ margin: "0 0 6px" }}>
            <strong>Agents</strong> understand, reason, and explain — they never calculate a schedule, invent an
            inventory number, or move money on their own.
          </p>
          <p style={{ margin: "0 0 6px" }}>
            <strong>Deterministic services</strong> calculate, validate, schedule, and persist — the same real code
            path whether triggered from this chat or a button click elsewhere.
          </p>
          <p style={{ margin: 0 }}>
            <strong>One honest caveat:</strong> APS Platform (the manufacturing app) has its own direct UI for
            shop-floor work — starting an operation, recording a goods receipt, logging a quality inspection. Those
            actions call the same deterministic services directly and do <em>not</em> pass through this agent. This
            console only orchestrates the sales/chat surface, not every action in the system.
          </p>
        </div>
      )}
    </div>
  );
}
