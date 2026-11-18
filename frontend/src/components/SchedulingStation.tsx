// frontend/src/components/SchedulingStation.tsx
import React, { useState } from "react";
import {
  Factory,
  Cpu,
  Clock,
  Sliders,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Download,
  Layers,
  ShieldCheck,
  Activity,
  Wrench,
  Boxes,
  FileText,
  ChevronRight,
  Eye,
  Search,
} from "lucide-react";

interface SchedulingStationProps {
  ganttData: any;
  materials: any[];
  auditLogs: any[];
  selectedMachine: string;
  setSelectedMachine: (v: string) => void;
  downtimeHours: number;
  setDowntimeHours: (v: number) => void;
  simulating: boolean;
  disruptionResult: any;
  selectedScenarioIndex: number;
  setSelectedScenarioIndex: (v: number) => void;
  applyingMitigation: boolean;
  mitigationMessage: string | null;
  setMitigationMessage: (v: string | null) => void;
  handleSimulateDisruption: () => Promise<void>;
  handleApplyMitigation: (scenario?: any) => Promise<void>;
  ganttWorkCenterFilter: string;
  setGanttWorkCenterFilter: (v: string) => void;
  filteredGanttResources: any[];
  inventoryHealthFilter: string;
  setInventoryHealthFilter: (v: string) => void;
  filteredMaterials: any[];
  selectedOperation: any;
  setSelectedOperation: (v: any) => void;
  exportToCsv: (filename: string, rows: Record<string, any>[]) => void;
}

export default function SchedulingStation(props: SchedulingStationProps) {
  const [subTab, setSubTab] = useState<"gantt" | "copilot" | "inventory" | "audit">("gantt");

  const totalOps = props.ganttData?.total_operations_scheduled || 0;
  const activeResourcesCount = props.ganttData?.resources?.length || 9;
  const lowStockCount = props.materials.filter((m) => m.current_stock < m.safety_stock).length;

  const allScenarios = props.disruptionResult?.scenarios || [];
  const activeScenario =
    allScenarios.length > 0 ? allScenarios[props.selectedScenarioIndex] || allScenarios[0] : null;

  return (
    <div className="space-y-6">
      {/* Role & Station Identification Ribbon */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d1017] p-4 rounded-xl border border-indigo-500/20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold">
            <Factory className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-indigo-400">
                Seat 2 · Plant Floor & Operations Workstation
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                Oracle Production Scheduling (APS)
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight mt-0.5">
              Production Scheduling & Finite Capacity Dispatch Console
            </h1>
          </div>
        </div>

        {/* Dispatcher Persona & Quick Stats */}
        <div className="flex items-center space-x-3 text-xs">
          <div className="text-right">
            <div className="font-semibold text-slate-200">Dave Vance</div>
            <div className="text-slate-400 text-[11px] font-mono">Master Plant Dispatcher · Austin Plant #1</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-300 font-bold text-xs">
            DV
          </div>
        </div>
      </div>

      {/* Operations Telemetry Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">PLANT WORK CENTERS</span>
          <div className="text-xl font-bold font-mono text-slate-100 mt-1">4 Centers / 9 Assets</div>
          <span className="text-[10px] text-slate-400">CNC, Fab, Assembly, QC</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">SCHEDULED OPERATIONS</span>
          <div className="text-xl font-bold font-mono text-blue-400 mt-1">{totalOps} Active Ops</div>
          <span className="text-[10px] text-emerald-400">CP-SAT Optimized</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">BOTTLENECK STATUS</span>
          <div className="text-xl font-bold font-mono text-emerald-400 mt-1">Normal (87.2% OEE)</div>
          <span className="text-[10px] text-slate-400">Sequence-Minimized</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">CRITICAL STOCK ITEMS</span>
          <div className={`text-xl font-bold font-mono mt-1 ${lowStockCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
            {lowStockCount} Shortage(s)
          </div>
          <span className="text-[10px] text-slate-400">Safety Buffer Monitored</span>
        </div>
      </div>

      {/* Internal Sub-Navigation */}
      <div className="flex border-b border-white/[0.08] space-x-1">
        <button
          onClick={() => setSubTab("gantt")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all ${
            subTab === "gantt"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Finite Master Gantt (9 Machines)</span>
        </button>

        <button
          onClick={() => setSubTab("copilot")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all ${
            subTab === "copilot"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>What-If Disruption Copilot</span>
          {props.disruptionResult && (
            <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-300 font-mono font-bold">
              Active
            </span>
          )}
        </button>

        <button
          onClick={() => setSubTab("inventory")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all ${
            subTab === "inventory"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>Physical Stock & Health (MMBE)</span>
          {lowStockCount > 0 && (
            <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-500/20 text-rose-300 font-mono font-bold">
              {lowStockCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setSubTab("audit")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all ${
            subTab === "audit"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>SOX Plant Audit Trail</span>
        </button>
      </div>

      {/* ============================================================== */}
      {/* SUB-TAB 1: FINITE MASTER GANTT                                 */}
      {/* ============================================================== */}
      {subTab === "gantt" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Shop-Floor Resource Timeline</h2>
              <p className="text-xs text-slate-400">
                Google OR-Tools CP-SAT finite capacity schedule minimizing sequence-dependent changeovers.
              </p>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <span className="flex items-center space-x-1.5 px-2.5 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300">
                <span className="w-2.5 h-2.5 rounded bg-blue-500"></span>
                <span>Active Operation</span>
              </span>
              <span className="flex items-center space-x-1.5 px-2.5 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300">
                <span className="w-2.5 h-2.5 rounded bg-indigo-500"></span>
                <span>Subsequent Op</span>
              </span>
              <button
                onClick={() => {
                  const rows: any[] = [];
                  props.filteredGanttResources.forEach((res: any) => {
                    if (res.operations && res.operations.length > 0) {
                      res.operations.forEach((op: any) => {
                        rows.push({
                          Machine_Code: res.machine_code,
                          Machine_Name: res.machine_name,
                          Work_Center: res.work_center_code,
                          Operation_Name: op.operation_name,
                          Operation_Number: op.operation_number,
                          Duration_Minutes: op.duration_minutes,
                          Planned_Start: op.planned_start || "",
                          Planned_End: op.planned_end || "",
                          Status: op.status,
                        });
                      });
                    } else {
                      rows.push({
                        Machine_Code: res.machine_code,
                        Machine_Name: res.machine_name,
                        Work_Center: res.work_center_code,
                        Operation_Name: "STANDBY / OPEN CAPACITY",
                        Operation_Number: 0,
                        Duration_Minutes: 0,
                        Planned_Start: "",
                        Planned_End: "",
                        Status: "AVAILABLE",
                      });
                    }
                  });
                  props.exportToCsv("finite_production_schedule.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors"
              >
                <Download className="w-3 h-3 text-indigo-400" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          {/* Work Center Filter Row */}
          <div className="flex items-center space-x-2 text-xs">
            <span className="text-slate-400 font-mono text-[11px] mr-1">Work Center:</span>
            {[
              { label: "All Centers (9)", val: "ALL" },
              { label: "CNC Machining (WC-CNC)", val: "WC-CNC" },
              { label: "Laser & Sheet (WC-FAB)", val: "WC-FAB" },
              { label: "Assembly Lines (WC-ASY)", val: "WC-ASY" },
              { label: "Quality Inspection (WC-QC)", val: "WC-QC" },
            ].map((wc) => (
              <button
                key={wc.val}
                onClick={() => props.setGanttWorkCenterFilter(wc.val)}
                className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors ${
                  props.ganttWorkCenterFilter === wc.val
                    ? "bg-indigo-600 text-white font-semibold"
                    : "bg-white/[0.04] text-slate-400 hover:text-slate-200"
                }`}
              >
                {wc.label}
              </button>
            ))}
          </div>

          {/* Interactive Gantt Rows */}
          <div className="hairline-panel rounded-xl p-5 space-y-3 font-mono text-xs">
            {props.filteredGanttResources.map((res: any) => (
              <div
                key={res.machine_id}
                className="grid grid-cols-12 gap-3 items-center p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06]"
              >
                <div className="col-span-3">
                  <div className="font-bold text-slate-200">{res.machine_code}</div>
                  <div className="text-[11px] text-slate-400 font-sans">{res.machine_name}</div>
                  <span className="text-[9px] px-1.5 py-0.2 bg-white/[0.06] text-indigo-300 rounded font-mono">
                    {res.work_center_code}
                  </span>
                </div>

                <div className="col-span-9 bg-[#0e1017] h-10 rounded border border-white/[0.06] relative flex items-center px-2 overflow-x-auto">
                  {res.operations?.length > 0 ? (
                    res.operations.map((op: any, oidx: number) => (
                      <div
                        key={op.id}
                        onClick={() => props.setSelectedOperation({ ...op, machine_code: res.machine_code })}
                        className={`h-7 px-3 rounded text-[11px] font-semibold flex items-center justify-between text-white shadow-sm mx-1 cursor-pointer hover:brightness-110 transition-all flex-shrink-0 ${
                          props.selectedOperation?.id === op.id
                            ? "ring-2 ring-white ring-offset-1 ring-offset-slate-900"
                            : ""
                        } ${
                          oidx % 2 === 0
                            ? "bg-indigo-600 border border-indigo-400/40"
                            : "bg-blue-600 border border-blue-400/40"
                        }`}
                        style={{ width: `${Math.max(160, op.duration_minutes * 1.2)}px` }}
                      >
                        <span className="truncate">{op.operation_name}</span>
                        <span className="text-[10px] opacity-80 ml-2">{op.duration_minutes}m</span>
                      </div>
                    ))
                  ) : (
                    <span className="text-[11px] text-slate-600 italic">Open Capacity (Standby)</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Selected Operation Detail Card */}
          {props.selectedOperation && (
            <div className="hairline-panel-elevated p-4 rounded-xl flex items-center justify-between animate-in fade-in duration-200 border border-indigo-500/30">
              <div className="flex items-center space-x-3 text-xs">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 font-bold">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-semibold text-slate-100 text-sm">
                    {props.selectedOperation.operation_name} (Op #{props.selectedOperation.operation_number})
                  </div>
                  <div className="text-slate-400 font-mono text-[11px]">
                    Machine: <strong>{props.selectedOperation.machine_code}</strong> · Duration:{" "}
                    <strong>{props.selectedOperation.duration_minutes} minutes</strong> · Status:{" "}
                    <strong>{props.selectedOperation.status}</strong>
                  </div>
                </div>
              </div>
              <button
                onClick={() => props.setSelectedOperation(null)}
                className="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded bg-white/[0.04] border border-white/[0.08]"
              >
                Close Detail
              </button>
            </div>
          )}
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 2: WHAT-IF DISRUPTION COPILOT                          */}
      {/* ============================================================== */}
      {subTab === "copilot" && (
        <div className="space-y-6">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-indigo-400" />
              <span>Autonomous Disruption & What-If Copilot</span>
            </h2>
            <p className="text-xs text-slate-400">
              When breakdown or supply disruptions occur, the solver evaluates alternate routes and shifts without manual guesswork.
            </p>
          </div>

          {props.mitigationMessage && (
            <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-950/50 text-emerald-100 flex items-center justify-between shadow-xl animate-in fade-in duration-200">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
                  ✓
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-emerald-200">Disruption Mitigation Plan Applied</h3>
                  <p className="text-xs text-emerald-300/90 font-mono mt-0.5">{props.mitigationMessage}</p>
                </div>
              </div>
              <button
                onClick={() => props.setMitigationMessage(null)}
                className="text-xs text-emerald-300 hover:text-white px-2.5 py-1 bg-emerald-900/40 rounded border border-emerald-700/50"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Incident Injection Control */}
            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <h3 className="font-bold text-xs text-slate-300 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span>Simulate Shop-Floor Incident</span>
              </h3>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="text-slate-400 block mb-1">Target Machine Failure</label>
                  <select
                    value={props.selectedMachine}
                    onChange={(e) => props.setSelectedMachine(e.target.value)}
                    className="w-full bg-[#0a0b0e] border border-white/[0.1] rounded p-2 text-slate-200"
                  >
                    <option value="CNC-01">CNC-01 (Haas 5-Axis)</option>
                    <option value="LASER-01">LASER-01 (Amada Fiber Laser)</option>
                    <option value="ASY-01">ASY-01 (Automated Assembly)</option>
                  </select>
                </div>

                <div>
                  <label className="text-slate-400 block mb-1">Unscheduled Downtime (Hours)</label>
                  <input
                    type="number"
                    value={props.downtimeHours}
                    onChange={(e) => props.setDowntimeHours(Number(e.target.value))}
                    className="w-full bg-[#0a0b0e] border border-white/[0.1] rounded p-2 text-slate-200 font-mono"
                  />
                </div>

                <button
                  onClick={props.handleSimulateDisruption}
                  disabled={props.simulating}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg text-xs flex items-center justify-center space-x-2 shadow-sm transition-all cursor-pointer"
                >
                  {props.simulating ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Solving Multi-Scenario What-If...</span>
                    </>
                  ) : (
                    <>
                      <Cpu className="w-3.5 h-3.5" />
                      <span>Run What-If Solver</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Simulation Result */}
            <div className="lg:col-span-2 space-y-4">
              {props.disruptionResult && activeScenario ? (
                <div className="hairline-panel-elevated rounded-xl p-6 space-y-5 animate-in fade-in duration-200">
                  {/* Multi-Scenario Switcher Tabs */}
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-mono text-slate-400 uppercase tracking-wider font-semibold">
                        What-If Trade-Off Scenarios ({allScenarios.length} Evaluated)
                      </span>
                      <span className="text-[11px] font-mono text-emerald-400 font-bold">
                        Feasibility: {activeScenario.feasibility}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {allScenarios.map((sc: any, idx: number) => {
                        const isSelected = props.selectedScenarioIndex === idx;
                        return (
                          <button
                            key={sc.scenario_id || idx}
                            onClick={() => props.setSelectedScenarioIndex(idx)}
                            className={`p-3.5 rounded-lg text-left border transition-all flex flex-col justify-between ${
                              isSelected
                                ? "bg-indigo-950/40 border-indigo-500/60 ring-1 ring-indigo-500/40"
                                : "bg-[#0a0b0e] border-white/[0.06] hover:border-white/[0.12] text-slate-400"
                            }`}
                          >
                            <div>
                              <div className="flex justify-between items-center mb-1">
                                <span
                                  className={`text-[10px] font-mono font-bold uppercase tracking-wider ${
                                    idx === 0 ? "text-indigo-300" : "text-amber-400"
                                  }`}
                                >
                                  {idx === 0 ? "★ Rank #1: Recommended" : "⚡ Rank #2: Alternative"}
                                </span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-300">
                                  {sc.feasibility}
                                </span>
                              </div>
                              <div className="font-semibold text-xs text-slate-100">{sc.name}</div>
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono mt-2 pt-2 border-t border-white/[0.06] flex justify-between">
                              <span>
                                Makespan: <strong className="text-slate-200">+{sc.projected_makespan_delta_hours}h</strong>
                              </span>
                              <span>
                                Cost: <strong className="text-amber-400">+${sc.estimated_cost_delta}</strong>
                              </span>
                              <span>
                                Delay:{" "}
                                <strong className={sc.orders_delayed > 0 ? "text-rose-400" : "text-emerald-400"}>
                                  {sc.orders_delayed}
                                </strong>
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active Scenario Detailed View */}
                  <div className="pt-2 border-t border-white/[0.08] space-y-3">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-mono font-bold uppercase px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                          Active Scenario
                        </span>
                        <h2 className="text-base font-bold text-white">{activeScenario.name}</h2>
                      </div>
                      <p className="text-xs text-slate-300 mt-1">{activeScenario.action}</p>
                    </div>

                    <div className="grid grid-cols-3 gap-3 my-3">
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block font-mono">Makespan Delta</span>
                        <span className="text-sm font-bold font-mono text-slate-200">
                          +{activeScenario.projected_makespan_delta_hours}h
                        </span>
                      </div>
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block font-mono">Cost Delta</span>
                        <span className="text-sm font-bold font-mono text-amber-400">
                          +${activeScenario.estimated_cost_delta}
                        </span>
                      </div>
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block font-mono">Customer Delays</span>
                        <span
                          className={`text-sm font-bold font-mono ${
                            activeScenario.orders_delayed > 0 ? "text-rose-400" : "text-emerald-400"
                          }`}
                        >
                          {activeScenario.orders_delayed} order(s)
                        </span>
                      </div>
                    </div>

                    <div className="text-xs text-slate-400 italic bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                      "{activeScenario.rationale}"
                    </div>

                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={() => props.handleApplyMitigation(activeScenario)}
                        disabled={props.applyingMitigation}
                        className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-lg text-xs shadow-sm flex items-center space-x-1.5 transition-all cursor-pointer"
                      >
                        {props.applyingMitigation ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Executing Mitigation Protocol...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Commit & Execute: {activeScenario.name}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="hairline-panel rounded-xl p-12 text-center text-slate-500 flex flex-col items-center justify-center h-full">
                  <Sliders className="w-10 h-10 mb-2 opacity-30" />
                  <p className="text-sm font-medium">Select a machine and trigger an incident simulation.</p>
                  <p className="text-xs text-slate-600 max-w-sm mt-1">
                    The Copilot runs multi-objective What-If solvers to protect customer delivery commitments.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 3: PHYSICAL STOCK & INVENTORY HEALTH (SAP MMBE)        */}
      {/* ============================================================== */}
      {subTab === "inventory" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Plant Stock & Safety Buffers (MMBE)</h2>
              <p className="text-xs text-slate-400">
                Direct view into plant raw materials, WIP inventory, safety levels, and unit valuations.
              </p>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <span className="text-slate-400 font-mono text-[11px] mr-1">Filter Stock:</span>
              {[
                { label: `All Items (${props.materials.length})`, val: "ALL" },
                { label: `Critical (${lowStockCount})`, val: "LOW" },
                { label: "Healthy", val: "HEALTHY" },
              ].map((f) => (
                <button
                  key={f.val}
                  onClick={() => props.setInventoryHealthFilter(f.val)}
                  className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    props.inventoryHealthFilter === f.val
                      ? "bg-indigo-600 text-white font-semibold"
                      : "bg-white/[0.04] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <button
                onClick={() => {
                  const rows = props.filteredMaterials.map((m) => ({
                    SKU: m.sku,
                    Name: m.name,
                    Type: m.material_type,
                    Current_Stock: m.current_stock,
                    Safety_Stock: m.safety_stock,
                    Unit_Cost: m.cost_per_unit,
                    Total_Valuation: m.current_stock * m.cost_per_unit,
                  }));
                  props.exportToCsv("inventory_stock_valuation.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors ml-2"
              >
                <Download className="w-3 h-3 text-indigo-400" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">SKU / MATERIAL</th>
                  <th className="py-2.5 px-4 font-semibold">TYPE</th>
                  <th className="py-2.5 px-4 font-semibold text-right">ON HAND</th>
                  <th className="py-2.5 px-4 font-semibold text-right">SAFETY STOCK</th>
                  <th className="py-2.5 px-4 font-semibold text-right">UNIT COST</th>
                  <th className="py-2.5 px-4 font-semibold text-right">VALUATION</th>
                  <th className="py-2.5 px-4 font-semibold">HEALTH</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.filteredMaterials.map((m: any) => {
                  const isLow = m.current_stock < m.safety_stock;
                  return (
                    <tr key={m.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-200">{m.sku}</div>
                        <div className="text-[11px] text-slate-400 font-sans">{m.name}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/[0.04] text-slate-300 border border-white/[0.06]">
                          {m.material_type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-slate-200">{m.current_stock}</td>
                      <td className="py-3 px-4 text-right text-slate-400">{m.safety_stock}</td>
                      <td className="py-3 px-4 text-right text-slate-300">${m.cost_per_unit}</td>
                      <td className="py-3 px-4 text-right text-slate-200 font-semibold">
                        ${(m.current_stock * m.cost_per_unit).toLocaleString()}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                            isLow
                              ? "bg-rose-500/10 text-rose-300 border border-rose-500/30"
                              : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                          }`}
                        >
                          {isLow ? (
                            <>
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              <span>Critical Stock</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              <span>Healthy</span>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 4: SOX PLANT AUDIT TRAIL                               */}
      {/* ============================================================== */}
      {subTab === "audit" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Plant Operations SOX Audit Ledger</h2>
              <p className="text-xs text-slate-400">
                Cryptographically verifiable, immutable record of shop-floor dispatch mutations and mitigation protocols.
              </p>
            </div>
            <button
              onClick={() => {
                const rows = props.auditLogs.map((log) => ({
                  Timestamp: log.timestamp,
                  Action: log.action,
                  Entity_Type: log.entity_type,
                  Entity_ID: log.entity_id,
                  User_Role: log.user_role || "SYSTEM_DISPATCHER",
                  Details: typeof log.details === "object" ? JSON.stringify(log.details) : log.details,
                }));
                props.exportToCsv("operations_sox_audit.csv", rows);
              }}
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors"
            >
              <Download className="w-3 h-3 text-indigo-400" />
              <span>Export Audit Trail (CSV)</span>
            </button>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">TIMESTAMP</th>
                  <th className="py-2.5 px-4 font-semibold">ACTION</th>
                  <th className="py-2.5 px-4 font-semibold">ENTITY</th>
                  <th className="py-2.5 px-4 font-semibold">USER / AGENT</th>
                  <th className="py-2.5 px-4 font-semibold">DETAILS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.auditLogs.length > 0 ? (
                  props.auditLogs.slice(0, 15).map((log: any, idx: number) => (
                    <tr key={log.id || idx} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 px-4 text-slate-400">{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : "—"}</td>
                      <td className="py-2.5 px-4 font-bold text-indigo-400">{log.action}</td>
                      <td className="py-2.5 px-4 text-slate-300">{log.entity_type}: {log.entity_id}</td>
                      <td className="py-2.5 px-4 text-slate-400">{log.user_role || "DISPATCHER"}</td>
                      <td className="py-2.5 px-4 text-slate-400 text-[11px] truncate max-w-xs">
                        {typeof log.details === "object" ? JSON.stringify(log.details) : log.details}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500 italic">
                      No audit entries recorded in current session.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
