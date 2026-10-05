"use client";

import { useState, type FormEvent } from "react";
import { runWorkflow } from "@/lib/api";
import type { WorkflowResult } from "@/types/workflow";
import { nodeMeta } from "@/lib/graphNodes";
import { PageHeader, Panel, AlertBanner, Button } from "@/components/ui";

// Node labels now come from lib/graphNodes.ts (agreed with the user,
// discoverability pass) — this page used to keep its own, separately-drifted
// copy of this map (missing composed_execution/reschedule_request/
// inventory_quality_request entirely), and agent-console kept a third,
// even-smaller one. One shared source of truth now.
//
// The stage-by-stage blocks below stay hand-rolled rather than AgentCard
// (design-system pass, agreed with the user): this is a developer/debug
// view whose whole point is showing exactly what each node returned,
// including the raw LangGraph node id — AgentCard's collapsible-output
// pattern has no slot for that id, and dropping it here would contradict
// the page's own "nothing summarized" promise.

export default function AgentTracePage() {
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkflowResult | null>(null);

  async function submit(message: string) {
    if (!message.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await runWorkflow(message.trim());
      setResult(data);
      setDraft(message.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit(draft);
  }

  const path = result?.stages?.map((s) => nodeMeta(s.node).label).join(" → ");

  return (
    <>
      <PageHeader
        kicker="DEVELOPER VIEW"
        title="Agent trace"
        description={
          <>
            Runs a request the same way New Request does, but shows the real execution — every
            LangGraph node that actually ran, in order, and exactly what each one added to state.
            The order of stages below <em>is</em> the routing decision: which conditional edge fired
            at each branch point is visible directly from which node runs next.
          </>
        }
      />

      <Panel>
        <form onSubmit={handleSubmit} className="field">
          <label>REQUEST</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Northgate Traders wants to order 10 Wireless Mouse units."
            autoFocus
          />
          <div className="btn-row">
            <Button type="submit" disabled={loading}>
              {loading ? "Running..." : result ? "Re-run (edited text) →" : "Run →"}
            </Button>
          </div>
        </form>
        {result && (
          <p style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 10 }}>
            Edit the request above and press Re-run any time — there&apos;s no checkpointing in
            this graph, so a re-run always starts over from Intent, not from wherever the last run
            stopped.
          </p>
        )}
      </Panel>

      {error && <AlertBanner tone="danger" title="Request failed">{error}</AlertBanner>}

      {result && !result.stages && (
        <Panel>
          <p className="panel-sub">
            This run needed a follow-up answer before any node beyond Intent could execute
            (clarification requests short-circuit before the graph runs) — nothing to trace yet.
          </p>
        </Panel>
      )}

      {path && (
        <Panel title="Route taken">
          <p className="mono" style={{ fontSize: 12.5, color: "var(--text-soft)", lineHeight: 1.7 }}>
            {path}
          </p>
        </Panel>
      )}

      {result?.stages && result.stages.length > 0 && (
        <Panel
          title="Stage-by-stage output"
          subtitle={`${result.stages.length} node(s) executed. Each block below is exactly what that node returned — nothing summarized or reworded.`}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {result.stages.map((stage, i) => (
              <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
                <div
                  style={{
                    background: "var(--paper-2)",
                    padding: "8px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {nodeMeta(stage.node).icon} {i + 1}. {nodeMeta(stage.node).label}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 9.5,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        color: "var(--text-faint)",
                      }}
                    >
                      {nodeMeta(stage.node).category === "agent" ? "LLM" : nodeMeta(stage.node).category === "deterministic" ? "Deterministic" : "Routing"}
                    </span>
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                    {stage.node}
                  </span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: 14,
                    fontSize: 11.5,
                    overflowX: "auto",
                    background: "var(--card)",
                  }}
                >
                  {JSON.stringify(stage.output, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
