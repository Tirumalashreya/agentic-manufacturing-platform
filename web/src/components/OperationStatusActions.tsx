"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateOperationStatusAction, completeOperationAction, reportExceptionAction, recordQualityInspectionAction } from "@/app/(app)/actions";
import type { ExceptionType, QcResult } from "@/lib/services";
import { useJobsActionsPending } from "@/components/JobsActionsProvider";

const EXCEPTION_TYPES: ExceptionType[] = [
  "MACHINE_BREAKDOWN",
  "MATERIAL_SHORTAGE",
  "OPERATOR_UNAVAILABLE",
  "QUALITY_ISSUE",
  "MAINTENANCE",
  "BLOCKED",
  "OTHER",
];

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
  machineId,
  machineName,
  requiresInspection,
}: {
  operationId: string;
  status: string;
  scheduledStart: string; // ISO
  quantity: number;
  // Only needed so a MACHINE_BREAKDOWN exception can also fire the real
  // existing disruption chain (reportMachineBreakdown) — every other
  // exception type is persist+publish only and needs neither.
  machineId?: string | null;
  machineName?: string | null;
  // Real Quality (Phase 4, agreed with the user) — from this operation's
  // own routing step (RoutingOperation.requiresInspection). Every other
  // operation renders and behaves exactly as before this feature existed.
  requiresInspection?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { anyPending, setPending } = useJobsActionsPending();
  // Every button below disables on `anyPending` (any row in the table,
  // not just this one) — completing an operation removes its row and
  // shifts everything below it up, so a click landing during that reflow
  // must not be able to hit a different job's button. See
  // JobsActionsProvider's own doc comment for the real bug this closes.
  useEffect(() => {
    setPending(operationId, isPending);
    return () => setPending(operationId, false);
  }, [isPending, operationId, setPending]);
  const [error, setError] = useState<string | null>(null);
  const [showCompleteForm, setShowCompleteForm] = useState(false);
  const [actualStart, setActualStart] = useState(() => toDatetimeLocalValue(scheduledStart));
  const [actualEnd, setActualEnd] = useState(() => toDatetimeLocalValue(new Date().toISOString()));
  // Real scrap/rejection capture (agreed with the user) — defaults to
  // zero rejected, matching what "just click Complete" always reported
  // before this existed; an operator only needs to touch this when
  // something actually was rejected.
  const [rejectedUnits, setRejectedUnits] = useState(0);
  const [rejectionReason, setRejectionReason] = useState("");

  // Real production-exception capture (agreed with the user, Phase 1
  // completion) — Block now requires saying WHY, not just a bare status
  // flip. MACHINE_BREAKDOWN additionally asks for the same fault
  // code/duration the Disruption Simulator does, since selecting it also
  // fires that real chain (see reportExceptionAction).
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [exceptionType, setExceptionType] = useState<ExceptionType>("MATERIAL_SHORTAGE");
  const [exceptionNote, setExceptionNote] = useState("");
  const [faultCode, setFaultCode] = useState("MECH-FAIL");
  const [breakdownMinutes, setBreakdownMinutes] = useState(60);

  // Real Quality (Phase 4, agreed with the user) — a standalone action, not
  // folded into Complete, since inspection can genuinely happen after
  // completion (or be redone after rework, i.e. re-inspecting a DONE
  // operation that already has a result is expected, not an error).
  const [showInspectForm, setShowInspectForm] = useState(false);
  const [inspectNote, setInspectNote] = useState("");

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error ?? "Something went wrong");
      }
    });
  }

  function handleSubmitComplete(event: React.FormEvent) {
    event.preventDefault();
    run(() =>
      completeOperationAction(
        operationId,
        new Date(actualStart).toISOString(),
        new Date(actualEnd).toISOString(),
        quantity,
        rejectedUnits,
        rejectionReason || undefined
      )
    );
    setShowCompleteForm(false);
  }

  function handleSubmitBlock(event: React.FormEvent) {
    event.preventDefault();
    run(() =>
      reportExceptionAction(
        operationId,
        exceptionType,
        exceptionNote || undefined,
        exceptionType === "MACHINE_BREAKDOWN" ? machineId ?? undefined : undefined,
        exceptionType === "MACHINE_BREAKDOWN" ? faultCode : undefined,
        exceptionType === "MACHINE_BREAKDOWN" ? breakdownMinutes : undefined
      )
    );
    setShowBlockForm(false);
  }

  function handleSubmitInspect(result: QcResult) {
    run(() => recordQualityInspectionAction(operationId, result, inspectNote || undefined));
    setShowInspectForm(false);
    setInspectNote("");
  }

  if (showInspectForm) {
    return (
      <div className="pointer-events-auto flex flex-col gap-1.5">
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">
          Note (optional)
          <input
            type="text"
            value={inspectNote}
            onChange={(e) => setInspectNote(e.target.value)}
            placeholder="e.g. dimension out of tolerance"
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          />
        </label>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={anyPending}
            onClick={() => handleSubmitInspect("PASS")}
            className="rounded-md bg-success-soft px-2 py-1 text-[11px] font-medium text-success hover:brightness-95 disabled:opacity-50"
          >
            Pass
          </button>
          <button
            type="button"
            disabled={anyPending}
            onClick={() => handleSubmitInspect("FAIL")}
            className="rounded-md bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger hover:brightness-95 disabled:opacity-50"
          >
            Fail
          </button>
          <button
            type="button"
            onClick={() => setShowInspectForm(false)}
            className="rounded-md bg-surface-muted px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (showBlockForm) {
    return (
      <form onSubmit={handleSubmitBlock} className="pointer-events-auto flex flex-col gap-1.5">
        <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
          Reason
          <select
            value={exceptionType}
            onChange={(e) => setExceptionType(e.target.value as ExceptionType)}
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          >
            {EXCEPTION_TYPES.map((t) => (
              <option key={t} value={t} disabled={t === "MACHINE_BREAKDOWN" && !machineId}>
                {t.replaceAll("_", " ")}
                {t === "MACHINE_BREAKDOWN" && !machineId ? " (no machine)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">
          Note (optional)
          <input
            type="text"
            value={exceptionNote}
            onChange={(e) => setExceptionNote(e.target.value)}
            placeholder="e.g. awaiting replacement bearing"
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          />
        </label>
        {exceptionType === "MACHINE_BREAKDOWN" && machineId && (
          <>
            <p className="text-[10px] text-muted">
              Also reports a real breakdown on {machineName ?? "this machine"} — blocks capacity and reschedules.
            </p>
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
              Fault code
              <input
                type="text"
                value={faultCode}
                onChange={(e) => setFaultCode(e.target.value)}
                className="w-24 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
              Duration (min)
              <input
                type="number"
                min={1}
                value={breakdownMinutes}
                onChange={(e) => setBreakdownMinutes(Math.max(Number(e.target.value) || 1, 1))}
                className="w-16 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
              />
            </label>
          </>
        )}
        <div className="flex gap-1.5">
          <button
            type="submit"
            disabled={anyPending}
            className="rounded-md bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger hover:brightness-95 disabled:opacity-50"
          >
            Block
          </button>
          <button
            type="button"
            onClick={() => setShowBlockForm(false)}
            className="rounded-md bg-surface-muted px-2 py-1 text-[11px] font-medium text-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </form>
    );
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
        <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
          Rejected qty (of {quantity})
          <input
            type="number"
            min={0}
            max={quantity}
            value={rejectedUnits}
            onChange={(e) => setRejectedUnits(Math.min(Math.max(Number(e.target.value) || 0, 0), quantity))}
            className="w-16 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
          />
        </label>
        {rejectedUnits > 0 && (
          <label className="flex flex-col gap-0.5 text-[11px] text-muted">
            Reason for rejection
            <input
              type="text"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g. dimension out of tolerance"
              className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-foreground"
            />
          </label>
        )}
        <div className="flex gap-1.5">
          <button
            type="submit"
            disabled={anyPending}
            className="rounded-md bg-success-soft px-2 py-1 text-[11px] font-medium text-success hover:brightness-95 disabled:opacity-50"
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
    <div className="pointer-events-auto flex flex-col gap-1">
      <div className="flex gap-1.5">
        {(status === "PLANNED" || status === "SCHEDULED") && (
          <button
            type="button"
            disabled={anyPending}
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
              disabled={anyPending}
              onClick={() => setShowCompleteForm(true)}
              className="rounded-md bg-success-soft px-2 py-1 text-[11px] font-medium text-success hover:brightness-95 disabled:opacity-50"
            >
              Complete
            </button>
            <button
              type="button"
              disabled={anyPending}
              onClick={() => setShowBlockForm(true)}
              className="rounded-md bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger hover:brightness-95 disabled:opacity-50"
            >
              Block
            </button>
          </>
        )}
        {status === "BLOCKED" && (
          <button
            type="button"
            disabled={anyPending}
            onClick={() => run(() => updateOperationStatusAction(operationId, "IN_PROGRESS"))}
            className="rounded-md bg-brand-100 px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 dark:bg-brand-900/40 dark:text-brand-300"
          >
            Resume
          </button>
        )}
        {status === "DONE" && requiresInspection && (
          <button
            type="button"
            disabled={anyPending}
            onClick={() => setShowInspectForm(true)}
            className="rounded-md bg-surface-muted px-2 py-1 text-[11px] font-medium text-foreground hover:bg-border"
          >
            Record inspection
          </button>
        )}
      </div>
      {error && <p className="max-w-[200px] text-[11px] text-danger">{error}</p>}
    </div>
  );
}
