"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { triggerSchedulingRunAction } from "@/app/(app)/actions";
import type { SchedulingMode } from "@/lib/services";

// All three modes below write a real, capacity-checked schedule (real
// Redis capacity buckets + a Postgres exclusion constraint enforce actual
// finite capacity) — there's no separate "finite" mode because these
// already are that. The one capacity-blind mode in this app is the
// Lead-time preview panel shown above this button, not a dropdown option.
const MODE_DESCRIPTIONS: Record<SchedulingMode, string> = {
  FORWARD:
    "Forward (finite capacity) — schedules from the earliest feasible start, filling machine capacity forward in time. Default; best for most orders.",
  BACKWARD:
    "Backward (finite capacity) — schedules from each order's due date backward, placing operations as late as possible while still meeting the deadline.",
  BOTTLENECK:
    "Bottleneck (Drum-Buffer-Rope) — identifies the busiest machine first and packs it tightly; other orders are sequenced around it. Best when one resource is a known constraint.",
};

export function RunSchedulingButton({ plantId }: { plantId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<SchedulingMode>("FORWARD");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleClick() {
    setMessage(null);
    startTransition(async () => {
      const result = await triggerSchedulingRunAction(plantId, mode);
      if (!result.ok) {
        setMessage(`Failed: ${result.error}`);
        return;
      }
      setMessage(
        `Scheduled ${result.result.operationsScheduled} operation(s) across ${result.result.ordersProcessed} order(s), ${result.result.conflictsDetected} conflict(s), published v${result.result.scheduleVersion}.`
      );
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as SchedulingMode)}
          className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
        >
          <option value="FORWARD">Forward scheduling</option>
          <option value="BACKWARD">Backward scheduling</option>
          <option value="BOTTLENECK">Bottleneck scheduling</option>
        </select>
        <Button onClick={handleClick} disabled={isPending}>
          {isPending ? "Running scheduling pipeline..." : "Run scheduling"}
        </Button>
      </div>
      <p className="max-w-md text-xs text-muted">{MODE_DESCRIPTIONS[mode]}</p>
      <p className="max-w-md text-xs text-muted">
        All three modes above write a real, capacity-checked schedule. For a capacity-blind rough-cut
        estimate instead, use the lead-time preview panel.
      </p>
      {message && <p className="text-sm text-muted">{message}</p>}
    </div>
  );
}
