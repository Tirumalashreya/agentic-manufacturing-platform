"use client";

import { useState, type FormEvent } from "react";

export function ClarificationCard({
  question,
  onAnswer,
  loading,
}: {
  question: string;
  onAnswer: (answer: string) => void;
  loading: boolean;
}) {
  const [answer, setAnswer] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    onAnswer(answer.trim());
  }

  return (
    <div className="clarify-card">
      <div className="panel-title">I need one more detail</div>
      <p className="panel-sub" style={{ marginBottom: 12 }}>
        {question}
      </p>
      <form onSubmit={handleSubmit} className="field" style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label>YOUR ANSWER</label>
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
        </div>
        <button type="submit" className="btn" disabled={loading}>
          {loading ? "Sending..." : "Continue →"}
        </button>
      </form>
    </div>
  );
}
