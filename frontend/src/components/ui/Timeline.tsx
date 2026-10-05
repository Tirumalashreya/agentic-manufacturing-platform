import type { ReactNode } from "react";

// Wraps the existing .timeline/.timeline-step/.timeline-marker/.timeline-rail
// classes (globals.css) — previously hand-built inline wherever a workflow
// step sequence was shown (design-system pass, agreed with the user).
export type TimelineStepStatus = "done" | "current" | "blocked" | "pending";

export function Timeline({
  steps,
}: {
  steps: { key: string; label: string; detail?: ReactNode; status: TimelineStepStatus }[];
}) {
  return (
    <div className="timeline">
      {steps.map((step, i) => (
        <div key={step.key}>
          <div className={`timeline-step ${step.status}`}>
            <div className="timeline-marker">
              {step.status === "done" ? "✓" : step.status === "blocked" ? "✕" : i + 1}
            </div>
            <div className="timeline-body">
              <div className="timeline-label">{step.label}</div>
              {step.detail && <div className="timeline-detail">{step.detail}</div>}
            </div>
          </div>
          {i < steps.length - 1 && <div className="timeline-rail" />}
        </div>
      ))}
    </div>
  );
}
