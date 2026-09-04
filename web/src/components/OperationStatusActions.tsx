"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOperationStatusAction, completeOperationAction } from "@/app/(app)/actions";

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time, not a raw ISO
// string (which is UTC and includes seconds/milliseconds).
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Manual shop-floor-style actions embedded in the Gantt hover card and the
// Production Planning operations table — this is the only place operation
// status changes today (see MachineGanttChart's doc comment on why there's
// no automatic time-based transition by default, aside from the opt-in demo
// ticker). Completing an operation asks for the REAL actual start/end
// (what genuinely happened) rather than assuming "now" — a real completion
// can differ from the schedule in either direction, which is the entire
// point of tracking deviation.
export function OperationStatusActions({
  operationId,
  status,
  scheduledStart,
  quantity,
}: {
  operationId: string;
  status: string;
  scheduledStart: string; // ISO
  quantity: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [actualStart, setActualStart] = useState(() => toDatetimeLocalValue(scheduledStart));
  const [actualEnd, setActualEnd] = useState(() => toDatetimeLocalValue(new Date().toISOString()));

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
    });
  }

  function handleSubmitComplete(event: React.FormEvent) {
    event.preventDefault();
    run(() =>
      completeOperationAction(operationId, new Date(actualStart).toISOString(), new Date(actualEnd).toISOString(), quantity)
    );
    setShowCompleteForm(false);
  }

  if (showCompleteForm) {
    return (
      <form onSubmit={handleSubmitComplete} className="pointer-events-auto flex flex-col gap-1.5">
        <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
          Actual start
          <input
            type="datetime-local"
            value={actualStart}
            onChange={(e) => setActualStart(e.target.value)}
            required
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
          Actual end
          <input
            type="datetime-local"
            value={actualEnd}
            onChange={(e) => setActualEnd(e.target.value)}
            required
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          />
        </label>
        <div className="flex gap-1.5">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 hover:bg-green-200 disabled:opacity-50 dark:bg-green-900/40 dark:text-green-300"
          >
            Submit
          </button>
          <button
            type="button"
            onClick={() => setShowCompleteForm(false)}
            className="rounded-md bg-surface-muted px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="pointer-events-auto flex gap-1.5">
      {(status === "PLANNED" || status === "SCHEDULED") && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => updateOperationStatusAction(operationId, "IN_PROGRESS"))}
          className="rounded-md bg-brand-100 px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 dark:bg-brand-900/40 dark:text-brand-300"
        >
          Start
        </button>
      )}
      {status === "IN_PROGRESS" && (
        <>
          <button
            type="button"
            disabled={isPending}
            onClick={() => setShowCompleteForm(true)}
            className="rounded-md bg-green-100 px-2 py-1 text-[11px] font-medium text-green-700 hover:bg-green-200 disabled:opacity-50 dark:bg-green-900/40 dark:text-green-300"
          >
            Complete
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => updateOperationStatusAction(operationId, "BLOCKED"))}
            className="rounded-md bg-red-100 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-300"
          >
            Block
          </button>
        </>
      )}
      {status === "BLOCKED" && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => updateOperationStatusAction(operationId, "IN_PROGRESS"))}
          className="rounded-md bg-brand-100 px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 dark:bg-brand-900/40 dark:text-brand-300"
        >
          Resume
        </button>
      )}
    </div>
  );
}
