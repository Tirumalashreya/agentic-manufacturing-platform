"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DeleteOperatorButton } from "@/components/DeleteOperatorButton";
import {
  createOperatorAction,
  createSkillAction,
  createShiftAction,
  addOperatorSkillAction,
  addOperatorShiftAction,
} from "@/app/(app)/actions";

type Skill = { id: string; name: string };
type ShiftOption = { id: string; name: string };
type Operator = {
  id: string;
  employeeId: string;
  name: string;
  department: string | null;
  employmentType: string;
  skills: { skill: { name: string }; proficiency: string }[];
  shifts: { shift: { name: string } }[];
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Real operator scheduling setup — see pipeline.ts's operator-resolution
// step (additive, only activates once operators actually exist). No
// per-operator login exists in this app, so this is a planner-facing admin
// page, not something an operator logs into themselves.
export function OperatorsManager({
  operators,
  skills,
  shifts,
}: {
  operators: Operator[];
  skills: Skill[];
  shifts: ShiftOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // New operator form
  const [employeeId, setEmployeeId] = useState("");
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [employmentType, setEmploymentType] = useState("FULL_TIME");

  // Quick-add skill/shift
  const [newSkillName, setNewSkillName] = useState("");
  const [newShiftName, setNewShiftName] = useState("");
  const [newShiftStart, setNewShiftStart] = useState("08:00");
  const [newShiftEnd, setNewShiftEnd] = useState("16:00");
  const [newShiftDays, setNewShiftDays] = useState<number[]>([1, 2, 3, 4, 5]);

  // Per-operator assignment selections
  const [selectedSkill, setSelectedSkill] = useState<Record<string, string>>({});
  const [selectedProficiency, setSelectedProficiency] = useState<Record<string, string>>({});
  const [selectedShift, setSelectedShift] = useState<Record<string, string>>({});

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      router.refresh();
    });
  }

  function handleCreateOperator(event: React.FormEvent) {
    event.preventDefault();
    run(async () => {
      const result = await createOperatorAction({ employeeId, name, department: department || undefined, employmentType });
      if (result.ok) {
        setEmployeeId("");
        setName("");
        setDepartment("");
      }
      return result;
    });
  }

  function toggleDay(day: number) {
    setNewShiftDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-foreground">Add operator</h2>
          <form onSubmit={handleCreateOperator} className="mt-3 flex flex-wrap items-end gap-3">
            <Input name="employeeId" label="Employee ID" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required />
            <Input name="name" label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Input name="department" label="Department (optional)" value={department} onChange={(e) => setDepartment(e.target.value)} />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-foreground">Employment type</label>
              <select
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value)}
                className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
              >
                <option value="FULL_TIME">Full time</option>
                <option value="PART_TIME">Part time</option>
                <option value="CONTRACT">Contract</option>
              </select>
            </div>
            <Button type="submit" size="sm" disabled={isPending}>Add operator</Button>
          </form>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-foreground">Add skill</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const result = await createSkillAction(newSkillName);
                  if (result.ok) setNewSkillName("");
                  return result;
                });
              }}
              className="mt-3 flex items-end gap-3"
            >
              <Input name="skillName" label="Skill name" value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} required />
              <Button type="submit" size="sm" disabled={isPending}>Add skill</Button>
            </form>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-foreground">Add shift</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const result = await createShiftAction({
                    name: newShiftName,
                    startTime: newShiftStart,
                    endTime: newShiftEnd,
                    daysOfWeek: newShiftDays,
                  });
                  if (result.ok) setNewShiftName("");
                  return result;
                });
              }}
              className="mt-3 flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-end gap-3">
                <Input name="shiftName" label="Shift name" value={newShiftName} onChange={(e) => setNewShiftName(e.target.value)} required />
                <Input name="startTime" label="Start" type="time" value={newShiftStart} onChange={(e) => setNewShiftStart(e.target.value)} required />
                <Input name="endTime" label="End" type="time" value={newShiftEnd} onChange={(e) => setNewShiftEnd(e.target.value)} required />
              </div>
              <div className="flex items-center gap-2">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      newShiftDays.includes(day)
                        ? "bg-brand-600 text-white"
                        : "bg-surface-muted text-muted hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Button type="submit" size="sm" disabled={isPending} className="self-start">Add shift</Button>
            </form>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Operator</th>
              <th className="px-4 py-3">Department</th>
              <th className="px-4 py-3">Skills</th>
              <th className="px-4 py-3">Add skill</th>
              <th className="px-4 py-3">Shifts</th>
              <th className="px-4 py-3">Add shift</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {operators.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted">No operators yet.</td>
              </tr>
            ) : (
              operators.map((operator) => (
                <tr key={operator.id}>
                  <td className="px-4 py-3 font-medium text-foreground">{operator.name} <span className="text-muted">({operator.employeeId})</span></td>
                  <td className="px-4 py-3 text-muted">{operator.department ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    {operator.skills.length === 0 ? "—" : operator.skills.map((s) => `${s.skill.name} (${s.proficiency})`).join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={selectedSkill[operator.id] ?? skills[0]?.id ?? ""}
                        onChange={(e) => setSelectedSkill((prev) => ({ ...prev, [operator.id]: e.target.value }))}
                        className="h-8 rounded-md border border-border bg-surface px-1.5 text-xs text-foreground"
                      >
                        {skills.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                      <select
                        value={selectedProficiency[operator.id] ?? "STANDARD"}
                        onChange={(e) => setSelectedProficiency((prev) => ({ ...prev, [operator.id]: e.target.value }))}
                        className="h-8 rounded-md border border-border bg-surface px-1.5 text-xs text-foreground"
                      >
                        <option value="TRAINEE">Trainee</option>
                        <option value="STANDARD">Standard</option>
                        <option value="EXPERT">Expert</option>
                      </select>
                      <button
                        type="button"
                        disabled={isPending || skills.length === 0}
                        onClick={() =>
                          run(() =>
                            addOperatorSkillAction(
                              operator.id,
                              selectedSkill[operator.id] ?? skills[0].id,
                              selectedProficiency[operator.id] ?? "STANDARD"
                            )
                          )
                        }
                        className="rounded-md bg-brand-100 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 dark:bg-brand-900/40 dark:text-brand-300"
                      >
                        Add
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {operator.shifts.length === 0 ? "—" : operator.shifts.map((s) => s.shift.name).join(", ")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={selectedShift[operator.id] ?? shifts[0]?.id ?? ""}
                        onChange={(e) => setSelectedShift((prev) => ({ ...prev, [operator.id]: e.target.value }))}
                        className="h-8 rounded-md border border-border bg-surface px-1.5 text-xs text-foreground"
                      >
                        {shifts.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={isPending || shifts.length === 0}
                        onClick={() => run(() => addOperatorShiftAction(operator.id, selectedShift[operator.id] ?? shifts[0].id))}
                        className="rounded-md bg-brand-100 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 dark:bg-brand-900/40 dark:text-brand-300"
                      >
                        Add
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <DeleteOperatorButton operatorId={operator.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
