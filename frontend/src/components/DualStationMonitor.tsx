// frontend/src/components/DualStationMonitor.tsx
import React, { useState } from "react";
import {
  Building2,
  Factory,
  Zap,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  Layers,
  Cpu,
  RefreshCw,
  Send,
  Eye,
  Sliders,
  Boxes,
} from "lucide-react";

interface DualStationMonitorProps {
  // Seat 1: Commercial Station props
  customers: any[];
  salesOrders: any[];
  prompt: string;
  setPrompt: (v: string) => void;
  evaluating: boolean;
  proposal: any;
  approving: boolean;
  handleEvaluateRFQ: () => Promise<void>;
  handleApprove: () => Promise<void>;
  handleViewOrderFlow: (id: string) => Promise<void>;

  // Seat 2: Scheduling Station props
  ganttData: any;
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
  selectedOperation: any;
  setSelectedOperation: (v: any) => void;

  // General
  actionLoading: string | null;
}

export default function DualStationMonitor(props: DualStationMonitorProps) {
  const [highlightedOrder, setHighlightedOrder] = useState<string | null>(null);

  const allScenarios = props.disruptionResult?.scenarios || [];
  const activeScenario =
    allScenarios.length > 0 ? allScenarios[props.selectedScenarioIndex] || allScenarios[0] : null;

  return (
    <div className="space-y-6">
      {/* Top Architecture Explanation & Digital Thread Bridge */}
      <div className="bg-[#0b0e14] p-5 rounded-xl border border-cyan-500/30 shadow-2xl relative overflow-hidden">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 relative z-10">
          <div>
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse"></span>
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-300">
                Synchronized Dual-Workstation Split View · Digital Thread Active
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                Zero-Latency Webhook Sync
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight mt-1">
              Under-The-Hood Single Platform vs. Role-Partitioned Workstation Screens
            </h1>
            <p className="text-xs text-slate-300 mt-0.5">
              Both screens share the identical PostgreSQL database, OR-Tools CP-SAT finite scheduler, and MRP engine.
              Each persona operates an isolated, noise-free workstation tailored to their job responsibilities.
            </p>
          </div>

          <div className="flex items-center space-x-3 text-xs font-mono bg-white/[0.04] p-2.5 rounded-lg border border-white/[0.08]">
            <div className="flex items-center space-x-1.5 text-blue-400">
              <Building2 className="w-4 h-4" />
              <span>Seat 1: Sales / CSR</span>
            </div>
            <ArrowRight className="w-4 h-4 text-cyan-400" />
            <div className="flex items-center space-x-1.5 text-indigo-400">
              <Factory className="w-4 h-4" />
              <span>Seat 2: Plant Dispatcher</span>
            </div>
          </div>
        </div>
      </div>

      {/* Side-by-Side Split Screen Container */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* ============================================================== */}
        {/* LEFT PANE: SEAT 1 - COMMERCIAL ORDER MANAGEMENT CLOUD           */}
        {/* ============================================================== */}
        <div className="hairline-panel rounded-xl p-5 space-y-4 border border-blue-500/30 bg-[#080a10]">
          {/* Station Title */}
          <div className="flex justify-between items-center border-b border-white/[0.08] pb-3">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold">
                <Building2 className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-blue-400 block">
                  SEAT 1 · SALES & CSR
                </span>
                <h2 className="text-sm font-bold text-white">Order Management Cloud</h2>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[11px] font-mono text-slate-300 block font-semibold">Sarah Jenkins</span>
              <span className="text-[10px] font-mono text-slate-400">CSR Lead · Inside Sales</span>
            </div>
          </div>

          {/* Quick RFQ Intake Box */}
          <div className="p-3.5 rounded-lg bg-[#0c0f17] border border-blue-500/20 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                <span>Sales Inquiry & Autonomous CTP Feasibility</span>
              </span>
              <span className="text-[10px] text-slate-400 font-mono">Real-time CP-SAT check</span>
            </div>

            <div className="flex space-x-2">
              <input
                type="text"
                value={props.prompt}
                onChange={(e) => props.setPrompt(e.target.value)}
                placeholder="e.g. Caterpillar needs 12x PMP-500 by Dec 12..."
                className="flex-1 bg-[#06080d] border border-white/[0.1] rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={props.handleEvaluateRFQ}
                disabled={props.evaluating}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-xs font-bold transition-all flex items-center space-x-1 cursor-pointer flex-shrink-0"
              >
                {props.evaluating ? (
                  <RefreshCw className="w-3 h-3 animate-spin" />
                ) : (
                  <>
                    <Send className="w-3 h-3" />
                    <span>Evaluate</span>
                  </>
                )}
              </button>
            </div>

            {/* Generated Quote Proposal */}
            {props.proposal && (
              <div className="p-3 rounded bg-blue-950/30 border border-blue-500/30 space-y-2 animate-in fade-in duration-200">
                <div className="flex justify-between items-start text-xs font-mono">
                  <div>
                    <span className="text-emerald-400 font-bold block">Feasible: {props.proposal.feasible ? "YES" : "NO"}</span>
                    <span className="text-slate-300">Target: {props.proposal.product_name} ({props.proposal.quantity} EA)</span>
                  </div>
                  <div className="text-right">
                    <span className="text-slate-100 font-bold">${props.proposal.total_price?.toLocaleString()}</span>
                    <span className="text-[10px] text-slate-400 block">Lead Time: {props.proposal.projected_lead_time_days}d</span>
                  </div>
                </div>
                <button
                  onClick={props.handleApprove}
                  disabled={props.approving}
                  className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded text-xs transition-all flex items-center justify-center space-x-1 cursor-pointer"
                >
                  {props.approving ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-3 h-3" />
                      <span>Book Sales Contract & Dispatch Operations</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Active Sales Orders Ledger */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-slate-200">Active Commercial Commitments</span>
              <span className="text-slate-400 font-mono text-[11px]">{props.salesOrders.length} Orders</span>
            </div>

            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {props.salesOrders.map((so: any) => {
                const isSelected = highlightedOrder === so.order_number;
                return (
                  <div
                    key={so.id}
                    onClick={() => {
                      setHighlightedOrder(isSelected ? null : so.order_number);
                      props.handleViewOrderFlow(so.id);
                    }}
                    className={`p-3 rounded-lg border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? "bg-blue-950/40 border-blue-500/60 ring-1 ring-blue-500/40"
                        : "bg-[#0b0e14] border-white/[0.06] hover:border-white/[0.12]"
                    }`}
                  >
                    <div className="flex justify-between items-start font-mono">
                      <div>
                        <span className="font-bold text-slate-100">{so.order_number}</span>
                        <div className="text-[11px] text-slate-400 font-sans">{so.customer_name}</div>
                      </div>
                      <div className="text-right">
                        <span className="text-emerald-400 font-bold">${so.total_amount?.toLocaleString()}</span>
                        <span className="text-[10px] text-slate-400 block">{so.quantity} units</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center mt-2 pt-2 border-t border-white/[0.04] text-[11px] font-mono">
                      <span className="text-slate-400">
                        Promise:{" "}
                        <strong className="text-slate-200">
                          {so.promised_delivery_date ? new Date(so.promised_delivery_date).toLocaleDateString() : "—"}
                        </strong>
                      </span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-300 border border-blue-500/20">
                        {so.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* RIGHT PANE: SEAT 2 - PRODUCTION SCHEDULING CONSOLE             */}
        {/* ============================================================== */}
        <div className="hairline-panel rounded-xl p-5 space-y-4 border border-indigo-500/30 bg-[#080a10]">
          {/* Station Title */}
          <div className="flex justify-between items-center border-b border-white/[0.08] pb-3">
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold">
                <Factory className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-400 block">
                  SEAT 2 · PLANT DISPATCHER
                </span>
                <h2 className="text-sm font-bold text-white">Production Scheduling Console</h2>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[11px] font-mono text-slate-300 block font-semibold">Dave Vance</span>
              <span className="text-[10px] font-mono text-slate-400">Master Scheduler · Shop Floor</span>
            </div>
          </div>

          {/* Plant Floor Mini Gantt Board */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="font-semibold text-slate-200 flex items-center space-x-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                <span>Shop Floor Machines (OR-Tools Finite Schedule)</span>
              </span>
              <span className="text-slate-400 font-mono text-[11px]">
                {props.ganttData?.total_operations_scheduled || 0} Operations
              </span>
            </div>

            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 font-mono text-xs">
              {(props.ganttData?.resources || []).map((res: any) => (
                <div
                  key={res.machine_id}
                  className="grid grid-cols-12 gap-2 items-center p-2 rounded bg-[#0b0e14] border border-white/[0.06]"
                >
                  <div className="col-span-4">
                    <div className="font-bold text-slate-200 text-[11px]">{res.machine_code}</div>
                    <div className="text-[10px] text-slate-400 truncate font-sans">{res.machine_name}</div>
                  </div>

                  <div className="col-span-8 bg-[#06080d] h-8 rounded border border-white/[0.06] relative flex items-center px-1 overflow-x-auto">
                    {res.operations?.length > 0 ? (
                      res.operations.map((op: any, oidx: number) => (
                        <div
                          key={op.id}
                          onClick={() => props.setSelectedOperation({ ...op, machine_code: res.machine_code })}
                          className={`h-6 px-2 rounded text-[10px] font-semibold flex items-center justify-between text-white shadow-sm mx-0.5 cursor-pointer hover:brightness-110 transition-all flex-shrink-0 ${
                            props.selectedOperation?.id === op.id
                              ? "ring-2 ring-white"
                              : ""
                          } ${
                            oidx % 2 === 0
                              ? "bg-indigo-600 border border-indigo-400/40"
                              : "bg-blue-600 border border-blue-400/40"
                          }`}
                          style={{ width: `${Math.max(120, op.duration_minutes * 0.9)}px` }}
                        >
                          <span className="truncate">{op.operation_name}</span>
                          <span className="text-[9px] opacity-80 ml-1">{op.duration_minutes}m</span>
                        </div>
                      ))
                    ) : (
                      <span className="text-[10px] text-slate-600 italic">Standby</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Mini Disruption What-If Copilot */}
          <div className="p-3.5 rounded-lg bg-[#0c0f17] border border-indigo-500/20 space-y-3 text-xs">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-slate-200 flex items-center space-x-1.5">
                <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                <span>Simulate Breakdown & Evaluate What-If</span>
              </span>
              <span className="text-[10px] font-mono text-amber-400">Multi-scenario</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-slate-400 block mb-0.5">Machine</label>
                <select
                  value={props.selectedMachine}
                  onChange={(e) => props.setSelectedMachine(e.target.value)}
                  className="w-full bg-[#06080d] border border-white/[0.1] rounded p-1.5 text-slate-200 text-xs"
                >
                  <option value="CNC-01">CNC-01 (Haas 5-Axis)</option>
                  <option value="LASER-01">LASER-01 (Fiber Laser)</option>
                  <option value="ASY-01">ASY-01 (Assembly)</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 block mb-0.5">Down Hours</label>
                <input
                  type="number"
                  value={props.downtimeHours}
                  onChange={(e) => props.setDowntimeHours(Number(e.target.value))}
                  className="w-full bg-[#06080d] border border-white/[0.1] rounded p-1.5 text-slate-200 text-xs font-mono"
                />
              </div>
            </div>

            <button
              onClick={props.handleSimulateDisruption}
              disabled={props.simulating}
              className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold rounded text-xs transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
            >
              {props.simulating ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <>
                  <Cpu className="w-3 h-3" />
                  <span>Solve Trade-Off Scenarios</span>
                </>
              )}
            </button>

            {/* Active Disruption Scenario Preview */}
            {activeScenario && (
              <div className="p-3 rounded bg-indigo-950/30 border border-indigo-500/30 space-y-2 animate-in fade-in duration-200">
                <div className="flex justify-between items-center font-mono text-[11px]">
                  <span className="text-indigo-300 font-bold">{activeScenario.name}</span>
                  <span className="text-emerald-400">{activeScenario.feasibility}</span>
                </div>
                <div className="grid grid-cols-3 gap-1 font-mono text-[10px] text-center">
                  <div className="bg-[#06080d] p-1.5 rounded">+{activeScenario.projected_makespan_delta_hours}h</div>
                  <div className="bg-[#06080d] p-1.5 rounded text-amber-400">+${activeScenario.estimated_cost_delta}</div>
                  <div className="bg-[#06080d] p-1.5 rounded text-emerald-400">{activeScenario.orders_delayed} delayed</div>
                </div>
                <button
                  onClick={() => props.handleApplyMitigation(activeScenario)}
                  disabled={props.applyingMitigation}
                  className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded text-xs transition-all flex items-center justify-center space-x-1 cursor-pointer"
                >
                  {props.applyingMitigation ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-3 h-3" />
                      <span>Commit Mitigation to Live Schedule</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
