"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { clearAllDataAction } from "@/app/(app)/actions";

// A real "reset and reimport" button — replaces having to ask for a manual
// database wipe every time a fresh upload needs testing. Two-step confirm,
// same pattern as DeleteOrderButton/DeleteOperatorButton, but the warning
// text is explicit about scope since this is total, not scoped to one row.
export function ClearDataButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClear() {
    setError(null);
    startTransition(async () => {
      const result = await clearAllDataAction();
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      router.refresh();
    });
  }

  if (confirming) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-danger/30 bg-danger-soft p-3">
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          This deletes everything — machines, products, routings, orders, schedules,
          operators, calendars — for a completely blank slate. This cannot be undone.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={handleClear}
            className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:brightness-95 disabled:opacity-50"
          >
            {isPending ? "Clearing…" : "Confirm — clear everything"}
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => setConfirming(false)}
            className="rounded-md bg-surface-muted px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-danger/30 hover:bg-danger-soft hover:text-danger"
      >
        Clear all data
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
