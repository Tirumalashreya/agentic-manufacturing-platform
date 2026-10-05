"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

// Real bug found live (agreed with the user): completing an operation
// removes its row from My Jobs entirely (status filters it out of the
// query), which shifts every row below it up by one — a genuinely janky
// moment if the next click lands during that reflow, since it now hits a
// different job's Start/Complete button instead of the one the operator
// meant to click. Each OperationStatusActions instance only knew about its
// own pending state (useTransition is per-component), so it had no way to
// stay disabled while a SIBLING row's action was in flight and about to
// reshuffle the table. This context is the fix: one shared "is anything in
// this table currently updating" flag, so every action button across every
// row disables itself the moment any one of them starts, and nothing is
// clickable again until the table has actually settled.
const JobsActionsContext = createContext<{
  anyPending: boolean;
  setPending: (operationId: string, pending: boolean) => void;
} | null>(null);

export function JobsActionsProvider({ children }: { children: ReactNode }) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  function setPending(operationId: string, pending: boolean) {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(operationId);
      else next.delete(operationId);
      return next;
    });
  }

  return (
    <JobsActionsContext.Provider value={{ anyPending: pendingIds.size > 0, setPending }}>
      {children}
    </JobsActionsContext.Provider>
  );
}

export function useJobsActionsPending() {
  const ctx = useContext(JobsActionsContext);
  // No provider above (a caller outside My Jobs, or before this is wired
  // up) — behaves exactly as before: only this row's own pending state
  // gates its buttons, no cross-row coordination.
  return ctx ?? { anyPending: false, setPending: () => {} };
}
