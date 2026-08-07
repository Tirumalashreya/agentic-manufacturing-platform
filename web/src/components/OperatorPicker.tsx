"use client";

import { useRouter } from "next/navigation";

// Fulcrum-style "view as operator" selector — no per-operator login exists
// in this app, so this is a plain dropdown, not an authenticated identity
// switch.
export function OperatorPicker({
  operators,
  selectedOperatorId,
}: {
  operators: { id: string; name: string; employeeId: string }[];
  selectedOperatorId?: string;
}) {
  const router = useRouter();

  return (
    <select
      value={selectedOperatorId ?? ""}
      onChange={(e) => router.push(e.target.value ? `/my-jobs?operatorId=${e.target.value}` : "/my-jobs")}
      className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
    >
      <option value="">Select operator…</option>
      {operators.map((op) => (
        <option key={op.id} value={op.id}>
          {op.name} ({op.employeeId})
        </option>
      ))}
    </select>
  );
}
