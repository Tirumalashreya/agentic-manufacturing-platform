"use client";

import { useEffect, useState } from "react";
import { listProjectMilestones } from "@/lib/api";
import type { Project, ProjectMilestone } from "@/types/channels";

const money = (n: number | null) => (n != null ? `₹${n.toLocaleString()}` : "—");

export function ProjectMilestoneBoard({ project }: { project: Project }) {
  const [milestones, setMilestones] = useState<ProjectMilestone[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjectMilestones(project.project_id)
      .then((data) => !cancelled && setMilestones([...data].sort((a, b) => a.sequence - b.sequence)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load milestones."));
    return () => {
      cancelled = true;
    };
  }, [project.project_id]);

  return (
    <div className="panel">
      <div className="panel-title">
        {project.project_id} — {project.scope_description || project.project_type}
      </div>
      <div className="panel-sub">
        {project.customer_name} · Contract value {money(project.contract_value)} · Retention{" "}
        {(project.retention_percent * 100).toFixed(0)}%
      </div>
      {error && <p style={{ color: "var(--alert)", fontSize: 12.5 }}>{error}</p>}
      {milestones && (
        <table className="grid">
          <thead>
            <tr>
              <th>Milestone</th>
              <th>% of contract</th>
              <th>Amount</th>
              <th>Billed</th>
              <th>Retained</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) => {
              const retained =
                m.billed_amount != null && m.amount != null ? m.amount - m.billed_amount : null;
              return (
                <tr key={m.milestone_id}>
                  <td>{m.milestone_name}</td>
                  <td className="mono">{(m.percent_of_contract * 100).toFixed(0)}%</td>
                  <td className="mono">{money(m.amount)}</td>
                  <td className="mono">{money(m.billed_amount)}</td>
                  <td className="mono">{money(retained)}</td>
                  <td>
                    <span className={`chip ${m.status === "SIGNED_OFF" ? "ok" : m.status === "DELIVERED" ? "warn" : "neutral"}`}>
                      {m.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
