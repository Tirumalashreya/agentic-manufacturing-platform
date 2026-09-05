"use client";

import { useState, type FormEvent } from "react";
import { runWorkflow } from "@/lib/api";
import { deriveTimeline } from "@/lib/deriveTimeline";
import { WorkflowTimeline } from "@/components/workflow/WorkflowTimeline";
import { ClarificationCard } from "@/components/request/ClarificationCard";
import type { WorkflowResult } from "@/types/workflow";

const EXAMPLES = [
  "ABC Corp wants to order 50 industrial pumps by October.",
  "We'd like to export 200 units to our distributor in Germany, terms FOB.",
  "Award us a turnkey manufacturing project for a new production line, contract value 1,000,000.",
  "Send 100 units to our distributor to sell on consignment.",
];

export default function NewRequestPage() {
  const [draft, setDraft] = useState("");
  const [conversation, setConversation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkflowResult | null>(null);

  async function submitMessage(message: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await runWorkflow(message);
      setResult(data);
      setConversation(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function handleInitialSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    submitMessage(draft.trim());
  }

  function handleClarificationAnswer(answer: string) {
    // The graph has no cross-request conversation memory yet, so a
    // clarification round-trip is a fresh call with the original
    // request and the answer combined into one message — not a
    // stateful multi-turn session on the backend.
    const combined = `${conversation}. ${answer}`;
    submitMessage(combined);
  }

  function handleReset() {
    setDraft("");
    setConversation(null);
    setResult(null);
    setError(null);
  }

  const needsClarification = result?.needs_clarification && result.clarification_question;
  const timeline = result && !needsClarification ? deriveTimeline(result) : null;

  return (
    <>
      <div className="doc-header">
        <div className="doc-kicker">NEW REQUEST</div>
        <div className="doc-title">Tell Ledger what you need</div>
        <div className="doc-desc">
          Describe the request in plain language — a sales order, an export shipment, a project
          award, a return, a consignment transfer, a service engagement, a subscription, or a
          financial adjustment. The Intent Agent figures out which.
        </div>
      </div>

      {!result && (
        <div className="panel">
          <form onSubmit={handleInitialSubmit} className="field">
            <label>REQUEST</label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. ABC Corp wants to order 50 industrial pumps by October."
              autoFocus
            />
            <div className="btn-row">
              <button type="submit" className="btn" disabled={loading}>
                {loading ? "Running..." : "Run Workflow →"}
              </button>
            </div>
          </form>
          <div style={{ marginTop: 16 }}>
            <div className="ledger-label" style={{ marginBottom: 8 }}>
              TRY ONE OF THESE
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setDraft(ex)}
                  className="btn secondary"
                  style={{ textAlign: "left" }}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="panel" style={{ borderColor: "var(--alert)" }}>
          <div className="panel-title" style={{ color: "var(--alert)" }}>
            Request failed
          </div>
          <p className="panel-sub">{error}</p>
        </div>
      )}

      {needsClarification && result && (
        <ClarificationCard
          question={result.clarification_question as string}
          onAnswer={handleClarificationAnswer}
          loading={loading}
        />
      )}

      {timeline && result && (
        <>
          <div className="panel">
            <div className="panel-title">Workflow</div>
            <div className="panel-sub">{result.user_message}</div>
            <WorkflowTimeline steps={timeline} />
          </div>

          <div className="panel">
            <div className="panel-title">Full Response</div>
            <p style={{ fontSize: 13.5, color: "var(--text-soft)" }}>{result.response}</p>
            <details style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)" }}>
              <summary style={{ cursor: "pointer" }}>Raw workflow state</summary>
              <pre
                style={{
                  marginTop: 8,
                  overflowX: "auto",
                  background: "var(--paper-2)",
                  padding: 12,
                  borderRadius: 6,
                }}
              >
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          </div>

          <button type="button" className="btn secondary" onClick={handleReset}>
            ← Start a new request
          </button>
        </>
      )}
    </>
  );
}
