"use client";

import { useState } from "react";
import { simulateSalesOrderSchedule, type SimulationResult } from "@/lib/api";

// Phase 2 (agreed with the user) — the one real, non-committing what-if
// the actual scheduling engine parameterizes: a capacity hypothetical on
// a real work center. Nothing here is written; scheduling-service's own
// scratch namespace is torn down on its side regardless of outcome.
// Quantity/date/priority hypotheticals aren't offered here on purpose —
// the real engine has no parameter for those without an actual order
// mutation, and this session's whole principle has been real data or an
// honest "not available," never a fabricated number.
export function WhatIfForm({
  salesOrderId,
  workCenters,
  currentCompletion,
}: {
  salesOrderId: string;
  workCenters: { id: string; code: string }[];
  currentCompletion: string | null;
}) {
  const [workCenterId, setWorkCenterId] = useState(workCenters[0]?.id ?? "");
  const [delta, setDelta] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await simulateSalesOrderSchedule(salesOrderId, workCenterId, delta);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
    } finally {
      setLoading(false);
    }
  }

  const changed = result && currentCompletion && result.projected_completion && result.projected_completion !== currentCompletion;

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>What-if: capacity change</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={workCenterId}
          onChange={(e) => setWorkCenterId(e.target.value)}
          style={{ background: "var(--paper)", color: "var(--text)", border: "1px solid var(--line-strong)", borderRadius: 5, padding: "6px 8px", fontSize: 12.5 }}
        >
          {workCenters.map((wc) => (
            <option key={wc.id} value={wc.id}>{wc.code}</option>
          ))}
        </select>
        <input
          type="number"
          value={delta}
          onChange={(e) => setDelta(Number(e.target.value))}
          style={{ width: 60, background: "var(--paper)", color: "var(--text)", border: "1px solid var(--line-strong)", borderRadius: 5, padding: "6px 8px", fontSize: 12.5 }}
        />
        <span style={{ fontSize: 12, color: "var(--text-soft)" }}>machine(s)</span>
        <button type="button" className="btn secondary" disabled={loading || !workCenterId} onClick={run} style={{ fontSize: 11.5, padding: "6px 12px" }}>
          {loading ? "Simulating…" : "Run what-if →"}
        </button>
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--alert)", marginTop: 10 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 6, background: "var(--card-2)", border: "1px solid var(--line-strong)" }}>
          {result.simulated_operations.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--text-soft)", margin: 0 }}>No simulated operations came back for this order under that change.</p>
          ) : (
            <>
              <p style={{ fontSize: 12.5, color: "var(--text)", margin: "0 0 6px" }}>
                Projected completion: <strong>{result.projected_completion ? new Date(result.projected_completion).toLocaleString() : "—"}</strong>
                {currentCompletion && (
                  <span style={{ color: changed ? "var(--accent)" : "var(--text-faint)" }}>
                    {" "}({changed ? "changes from" : "same as"} current: {new Date(currentCompletion).toLocaleString()})
                  </span>
                )}
              </p>
              <p style={{ fontSize: 12, color: "var(--text-soft)", margin: 0 }}>
                Conflicts detected: {result.conflicts_detected}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
