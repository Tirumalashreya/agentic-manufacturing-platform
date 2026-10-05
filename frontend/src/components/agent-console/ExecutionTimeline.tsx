"use client";

import { useEffect, useState } from "react";
import { getPipelineRun, type PipelineRunDetail } from "@/lib/api";
import { nodeMeta } from "@/lib/graphNodes";

// Real per-stage timestamps (discoverability pass, agreed with the user) —
// GET /pipeline/runs/:id (AgentPipelineRun/AgentStageResult) already
// existed and was already wired into lib/api.ts as getPipelineRun, but no
// page ever called it. These are real row-write times (Postgres
// createdAt), i.e. real completion order — NOT a measured per-stage
// duration, since no timing instrumentation exists anywhere in the
// backend. Both facts are stated honestly below rather than implied.
//
// run_id is only ever non-null when the backend's DATABASE_URL is
// configured (AgentPipelineRun writes are best-effort) — this component
// degrades to an honest, explicit "unavailable" state rather than hiding
// itself or showing a fake timeline when that's not the case.
export function ExecutionTimeline({ runId }: { runId: string | null }) {
  const [detail, setDetail] = useState<PipelineRunDetail | null | "loading" | "error">("loading");

  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }
    setDetail("loading");
    getPipelineRun(runId)
      .then((d) => setDetail(d))
      .catch(() => setDetail("error"));
  }, [runId]);

  if (!runId) {
    return (
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "6px 0 0" }}>
        Detailed timestamps unavailable for this run (no run id was recorded — this happens when the
        orchestrator's database isn't configured).
      </p>
    );
  }

  if (detail === "loading") {
    return <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "6px 0 0" }}>Loading real execution timeline…</p>;
  }

  if (detail === "error" || detail === null || detail.stages.length === 0) {
    return (
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "6px 0 0" }}>
        Detailed timestamps unavailable for this run.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <p style={{ fontSize: 10.5, color: "var(--text-faint)", margin: "0 0 6px" }}>
        Real stage-completion order and timestamps (run <span className="mono">{detail.id.slice(-8)}</span>) — not a
        measured duration; no per-stage timing is captured by the backend today.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {detail.stages.map((s) => (
          <li key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-soft)" }}>
            <span>
              {nodeMeta(s.stage).icon} {nodeMeta(s.stage).label}
            </span>
            <span className="mono" style={{ color: "var(--text-faint)" }}>
              {new Date(s.createdAt).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
