"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { runScenarioComparisonAction, type LatenessSummary, type ScenarioResult } from "@/app/(app)/actions";
import type { SchedulingMode } from "@/lib/services";

type WorkCenterOption = { id: string; code: string };

type ScenarioRow = {
  id: string;
  name: string;
  workCenterId: string;
  additionalMachineCount: number;
  mode: SchedulingMode;
};

const LATENESS_LABEL: Record<keyof LatenessSummary, string> = {
  LATE: "Late",
  AT_RISK: "At risk",
  ON_TRACK: "On track",
  NO_DUE_DATE: "No due date",
};

function makeScenario(workCenterId: string, index: number): ScenarioRow {
  return {
    id: crypto.randomUUID(),
    name: `Scenario ${index}`,
    workCenterId,
    additionalMachineCount: 1,
    mode: "FORWARD",
  };
}

// §17 "Advanced Simulation / What-If: planner defines 3 scenarios; system
// presents side-by-side KPI comparison" — this is that feature. Each
// scenario hypothetically adds machine capacity to a work center and
// replans with the real engine against its own scratch capacity namespace
// (so scenarios never interfere with each other or with anything real);
// results are compared against the SAME real current baseline side by side.
// "Apply for real" isn't a button here on purpose: acting on a good result
// is just running the normal scheduling pipeline once the real capacity
// change (e.g. adding the machine) is actually made.
export function WhatIfPanel({ plantId, workCenters }: { plantId: string; workCenters: WorkCenterOption[] }) {
  const [scenarios, setScenarios] = useState<ScenarioRow[]>(() =>
    workCenters.length > 0 ? [makeScenario(workCenters[0].id, 1)] : []
  );
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ baseline: LatenessSummary; scenarios: ScenarioResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function addScenario() {
    setScenarios((prev) => [...prev, makeScenario(workCenters[0]?.id ?? "", prev.length + 1)]);
  }

  function removeScenario(id: string) {
    setScenarios((prev) => prev.filter((s) => s.id !== id));
  }

  function updateScenario(id: string, patch: Partial<ScenarioRow>) {
    setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function handleRun() {
    setError(null);
    startTransition(async () => {
      const response = await runScenarioComparisonAction(
        plantId,
        scenarios.map((s) => ({
          name: s.name,
          mode: s.mode,
          capacityAdjustments: [{ workCenterId: s.workCenterId, additionalMachineCount: s.additionalMachineCount }],
        }))
      );
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(response);
    });
  }

  if (workCenters.length === 0) return null;

  const latenessKeys = Object.keys(LATENESS_LABEL) as (keyof LatenessSummary)[];

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">What-if: compare scenarios</h2>
        <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          Simulation — nothing written
        </span>
      </div>
      <p className="text-xs text-muted">
        Define a few hypothetical capacity changes and replan each with the real engine against a scratch
        namespace — zero rows written to the real schedule. Acting on a result means making the change for
        real (e.g. adding the machine) and running scheduling normally, a separate step.
      </p>

      <div className="flex flex-col gap-2">
        {scenarios.map((scenario) => (
          <div key={scenario.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
            <input
              type="text"
              value={scenario.name}
              onChange={(e) => updateScenario(scenario.id, { name: e.target.value })}
              className="h-9 w-32 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            />
            <select
              value={scenario.workCenterId}
              onChange={(e) => updateScenario(scenario.id, { workCenterId: e.target.value })}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            >
              {workCenters.map((wc) => (
                <option key={wc.id} value={wc.id}>{wc.code}</option>
              ))}
            </select>
            <span className="text-sm text-muted">+</span>
            <input
              type="number"
              min={1}
              max={10}
              value={scenario.additionalMachineCount}
              onChange={(e) => updateScenario(scenario.id, { additionalMachineCount: Math.max(1, Number(e.target.value)) })}
              className="h-9 w-16 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            />
            <span className="text-sm text-muted">machine(s)</span>
            <select
              value={scenario.mode}
              onChange={(e) => updateScenario(scenario.id, { mode: e.target.value as SchedulingMode })}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            >
              <option value="FORWARD">Forward</option>
              <option value="BACKWARD">Backward</option>
              <option value="BOTTLENECK">Bottleneck</option>
            </select>
            <button
              type="button"
              onClick={() => removeScenario(scenario.id)}
              className="ml-auto rounded-md px-2 py-1 text-xs text-muted hover:text-danger"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={addScenario}>
          Add scenario
        </Button>
        <Button variant="secondary" size="sm" onClick={handleRun} disabled={isPending || scenarios.length === 0}>
          {isPending ? "Simulating..." : "Run all scenarios"}
        </Button>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {result && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
              <tr>
                <th className="px-3 py-2">Metric</th>
                <th className="px-3 py-2">Baseline</th>
                {result.scenarios.map((s) => (
                  <th key={s.name} className="px-3 py-2">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {latenessKeys.map((key) => (
                <tr key={key}>
                  <td className="px-3 py-2 font-medium text-foreground">{LATENESS_LABEL[key]}</td>
                  <td className="px-3 py-2 text-muted">{result.baseline[key]}</td>
                  {result.scenarios.map((s) => (
                    <td key={s.name} className="px-3 py-2 text-muted">{s.error ? "—" : s.after[key]}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="px-3 py-2 font-medium text-foreground">Operations scheduled</td>
                <td className="px-3 py-2 text-muted">—</td>
                {result.scenarios.map((s) => (
                  <td key={s.name} className="px-3 py-2 text-muted">{s.error ? "—" : s.operationsScheduled}</td>
                ))}
              </tr>
              <tr>
                <td className="px-3 py-2 font-medium text-foreground">Conflicts</td>
                <td className="px-3 py-2 text-muted">—</td>
                {result.scenarios.map((s) => (
                  <td key={s.name} className="px-3 py-2 text-muted">{s.error ?? s.conflictsDetected}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
