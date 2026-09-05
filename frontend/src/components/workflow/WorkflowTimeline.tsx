import type { TimelineStep } from "@/types/workflow";

const MARKS: Record<TimelineStep["state"], string> = {
  done: "✓",
  current: "●",
  blocked: "✕",
  pending: "○",
};

export function WorkflowTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="timeline">
      {steps.map((step, i) => (
        <div key={step.label}>
          <div className={`timeline-step ${step.state}`}>
            <span className="timeline-marker">{MARKS[step.state]}</span>
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
