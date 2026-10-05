"use client";

import type { ReactNode } from "react";

// New — Ledger has no modal/dialog primitive at all today (confirmed in
// this session's design-system audit); every destructive/consequential
// action currently fires immediately on click with no confirmation step.
// Built for real upcoming uses (e.g. "Mark as Paid" needs an honest
// confirmation per the redesign plan's Phase 11) — deliberately plain, no
// backdrop blur/glassmorphism per the "calm, not gimmicky" direction.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(30,35,51,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        className="panel"
        style={{ maxWidth: 420, width: "90%", marginBottom: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-title">{title}</div>
        {description && <p className="panel-sub">{description}</p>}
        <div className="btn-row">
          <button type="button" className="btn" style={danger ? { background: "var(--alert)", borderColor: "var(--alert)" } : undefined} onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" className="btn secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
