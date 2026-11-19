// frontend/src/components/SchedulingStation.tsx
import React, { useState, useEffect } from "react";
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
  Gauge,
  Zap,
  Thermometer,
  BookOpen,
  Info,
  Check,
  Calendar,
  Users,
  Hammer,
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

const API_BASE = "http://localhost:8080/api/v1";

export default function SchedulingStation(props: SchedulingStationProps) {
  const [subTab, setSubTab] = useState<"gantt" | "heatmap" | "secondary" | "matrix" | "telemetry" | "copilot" | "inventory" | "audit">("gantt");
  const [showSapGuide, setShowSapGuide] = useState(false);
  const [selectedMatrixCell, setSelectedMatrixCell] = useState<{ from: string; to: string; time: number; note: string } | null>(null);
  const [enterpriseData, setEnterpriseData] = useState<any>(null);

  // Fetch Oracle Production Scheduling enterprise features
  useEffect(() => {
    fetch(`${API_BASE}/scheduling/enterprise-features`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setEnterpriseData(data))
      .catch((e) => console.error("Scheduling enterprise fetch error:", e));
  }, []);

  const totalOps = props.ganttData?.total_operations_scheduled || 0;
  const activeResourcesCount = props.ganttData?.resources?.length || 9;
  const lowStockCount = props.materials.filter((m) => m.current_stock < m.safety_stock).length;

  const allScenarios = props.disruptionResult?.scenarios || [];
  const activeScenario =
    allScenarios.length > 0 ? allScenarios[props.selectedScenarioIndex] || allScenarios[0] : null;

  // Changeover setup matrix data (tooling, alloy flush, calibration)
  const setupMaterials = [
    { code: "AL-6061", name: "Aluminum 6061" },
    { code: "SS-316L", name: "Stainless 316L" },
    { code: "INCONEL", name: "Inconel 625" },
    { code: "TI-64", name: "Titanium 6Al-4V" },
  ];

  const setupMatrixData: Record<string, Record<string, { time: number; penalty: string; note: string }>> = {
    "AL-6061": {
      "AL-6061": { time: 10, penalty: "MINIMAL", note: "Standard chip clear & tool inspection. Same spindle speeds." },
      "SS-316L": { time: 45, penalty: "MODERATE", note: "Coolant concentration adjustment, carbide insert change." },
      "INCONEL": { time: 80, penalty: "HIGH", note: "Rigid heavy-duty tooling install, high-pressure coolant purge." },
      "TI-64": { time: 65, penalty: "HIGH", note: "Ceramic tooling switch, vibration damping setup." },
    },
    "SS-316L": {
      "AL-6061": { time: 35, penalty: "MODERATE", note: "Spindle speed ramp-up, coolant tank flush to prevent cross-contamination." },
      "SS-316L": { time: 15, penalty: "MINIMAL", note: "Continuous grade run. Tool wear check only." },
      "INCONEL": { time: 70, penalty: "HIGH", note: "Heavy feed rate calibration, specialized end mill install." },
      "TI-64": { time: 60, penalty: "HIGH", note: "Thermal compensation sensor calibration." },
    },
    "INCONEL": {
      "AL-6061": { time: 90, penalty: "CRITICAL", note: "Full enclosure degreasing, high-speed balancing, total coolant replacement." },
      "SS-316L": { time: 50, penalty: "MODERATE", note: "Feed recalibration, moderate cleaning." },
      "INCONEL": { time: 20, penalty: "MINIMAL", note: "Same alloy batch. Pre-warmed spindle running." },
      "TI-64": { time: 75, penalty: "HIGH", note: "Rigid fixture swap, tool offset re-measurement." },
    },
    "TI-64": {
      "AL-6061": { time: 85, penalty: "CRITICAL", note: "Total de-burring cleaning to prevent galvanic corrosion." },
      "SS-316L": { time: 55, penalty: "MODERATE", note: "Standard tooling reset." },
      "INCONEL": { time: 70, penalty: "HIGH", note: "Extreme heat tolerance tooling setup." },
      "TI-64": { time: 15, penalty: "MINIMAL", note: "Continuous aerospace titanium run." },
    },
  };

  // Live Machine IoT Telemetry (Digital Twin)
  const machineTelemetry = [
    { code: "CNC-01", name: "Haas 5-Axis VF-4", status: "RUNNING", rpm: 11450, load: "78%", temp: "41.2°C", vibration: "0.28 mm/s", toolWear: 82, wearStatus: "HEALTHY", op: "OP-10 Impeller Roughing" },
    { code: "CNC-02", name: "Mori Seiki NMV5000", status: "RUNNING", rpm: 12200, load: "84%", temp: "43.8°C", vibration: "0.32 mm/s", toolWear: 94, wearStatus: "WARNING", op: "OP-20 Turbine Pocketing" },
    { code: "CNC-03", name: "Mazak Integrex e-500", status: "STANDBY", rpm: 0, load: "0%", temp: "28.5°C", vibration: "0.02 mm/s", toolWear: 45, wearStatus: "HEALTHY", op: "Awaiting Next Batch" },
    { code: "LASER-01", name: "Amada Fiber Laser 4kW", status: "RUNNING", rpm: 0, load: "92%", temp: "24.1°C", vibration: "0.12 mm/s", toolWear: 71, wearStatus: "HEALTHY", op: "OP-10 Shell Cutting" },
    { code: "LASER-02", name: "Trumpf TruLaser 5030", status: "RUNNING", rpm: 0, load: "88%", temp: "25.0°C", vibration: "0.14 mm/s", toolWear: 64, wearStatus: "HEALTHY", op: "OP-15 Bracket Profiling" },
    { code: "ASY-01", name: "Automated Pump Assembly", status: "RUNNING", rpm: 0, load: "65%", temp: "22.3°C", vibration: "0.08 mm/s", toolWear: 38, wearStatus: "HEALTHY", op: "OP-30 Rotor Stacking" },
    { code: "ASY-02", name: "Hydraulic Seal Assembly", status: "RUNNING", rpm: 0, load: "70%", temp: "22.1°C", vibration: "0.05 mm/s", toolWear: 29, wearStatus: "HEALTHY", op: "OP-35 O-Ring Seating" },
    { code: "QC-01", name: "Zeiss CMM Inspection Cell", status: "RUNNING", rpm: 0, load: "55%", temp: "20.1°C", vibration: "0.01 mm/s", toolWear: 15, wearStatus: "HEALTHY", op: "OP-40 Dimensional Verification" },
    { code: "PACK-01", name: "Robotic Packaging & Crate", status: "STANDBY", rpm: 0, load: "10%", temp: "21.0°C", vibration: "0.02 mm/s", toolWear: 20, wearStatus: "HEALTHY", op: "Ready for Staging" },
  ];

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

        {/* Dispatcher Persona & Guide Toggle */}
        <div className="flex items-center space-x-3 text-xs">
          <button
            onClick={() => setShowSapGuide(!showSapGuide)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-950/50 hover:bg-indigo-900/60 text-indigo-300 border border-indigo-500/30 transition-all cursor-pointer font-mono text-[11px]"
            title="View translation guide from legacy SAP / Oracle systems"
          >
            <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
            <span>{showSapGuide ? "Hide SAP Guide" : "Switching from SAP? (Guide)"}</span>
          </button>

          <div className="text-right border-l border-white/[0.08] pl-3">
            <div className="font-semibold text-slate-200">Dave Vance</div>
            <div className="text-slate-400 text-[11px] font-mono">Master Plant Dispatcher · Austin Plant #1</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-300 font-bold text-xs">
            DV
          </div>
        </div>
      </div>

      {/* SAP / Oracle Transition Guide for Dispatchers */}
      {showSapGuide && (
        <div className="p-5 rounded-xl bg-gradient-to-r from-indigo-950/60 to-[#0e111a] border border-indigo-500/30 text-xs space-y-3 animate-in fade-in duration-200">
          <div className="flex justify-between items-start">
            <div className="flex items-center space-x-2 text-indigo-300 font-bold text-sm">
              <Info className="w-4 h-4" />
              <span>Plant Dispatcher Guide: Why This Replaces Legacy SAP PP-DS & Old APS</span>
            </div>
            <button
              onClick={() => setShowSapGuide(false)}
              className="text-slate-400 hover:text-white font-mono text-xs px-2 py-0.5 bg-white/[0.04] rounded cursor-pointer"
            >
              ✕ Close
            </button>
          </div>

          <p className="text-slate-300 leading-relaxed">
            In traditional systems like <strong>SAP PP-DS (/SAPAPO/CDPS0)</strong> and legacy Oracle APS, dispatchers faced three major pain points:
            <strong> (1) Cryptic T-Codes and rigid tables</strong>, <strong> (2) Black-box scheduling heuristics</strong> that moved operations without explanation, and
            <strong> (3) Total disconnect from real-time IoT machine health</strong>. Here is how your new console eliminates these flaws:
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 font-mono text-[11px]">
            <div className="p-3 rounded-lg bg-[#08090d] border border-white/[0.08] space-y-1">
              <span className="text-rose-400 font-bold block">OLD SAP PP-DS</span>
              <div className="text-slate-400">Cryptic transaction codes (/SAPAPO/CDPS0, CM01), slow batch runs, and zero explanation for job sequence.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-indigo-500/30 space-y-1">
              <span className="text-indigo-300 font-bold block">NEW FINITE APS CONSOLE</span>
              <div className="text-slate-300">Google OR-Tools CP-SAT in-memory solving in 150ms. Sequence setup matrix visibly proves why jobs are grouped.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-emerald-500/30 space-y-1">
              <span className="text-emerald-400 font-bold block">REAL-TIME DIGITAL TWIN</span>
              <div className="text-slate-300">Live IoT spindle RPM, vibration, and tool wear so the schedule reflects actual machine physics, not paper dreams.</div>
            </div>
          </div>
        </div>
      )}

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
          <span className="text-[10px] text-slate-400">Setup Matrix Minimized</span>
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
      <div className="flex border-b border-white/[0.08] space-x-1 overflow-x-auto">
        <button
          onClick={() => setSubTab("gantt")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "gantt"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Master Gantt (9 Machines)</span>
        </button>

        <button
          onClick={() => setSubTab("heatmap")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "heatmap"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>Work Center Heatmap</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-500/20 text-rose-300 font-mono font-bold">
            88% Bottleneck
          </span>
        </button>

        <button
          onClick={() => setSubTab("secondary")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "secondary"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Hammer className="w-4 h-4" />
          <span>Tooling Fixtures & Crews</span>
        </button>

        <button
          onClick={() => setSubTab("matrix")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "matrix"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Wrench className="w-4 h-4" />
          <span>Setup Changeover Matrix</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/20 text-blue-300 font-mono">
            Optimized
          </span>
        </button>

        <button
          onClick={() => setSubTab("telemetry")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "telemetry"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Gauge className="w-4 h-4" />
          <span>Machine Digital Twin (IoT)</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        </button>

        <button
          onClick={() => setSubTab("copilot")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
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
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "inventory"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>Physical Stock (MMBE)</span>
          {lowStockCount > 0 && (
            <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-500/20 text-rose-300 font-mono font-bold">
              {lowStockCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setSubTab("audit")}
          className={`flex items-center space-x-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
            subTab === "audit"
              ? "border-indigo-500 text-indigo-400 bg-indigo-500/[0.04]"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>SOX Audit Trail</span>
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
                className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors cursor-pointer"
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
                className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer ${
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
                  <div className="text-[11px] text-slate-400 font-sans truncate">{res.machine_name}</div>
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
                className="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded bg-white/[0.04] border border-white/[0.08] cursor-pointer"
              >
                Close Detail
              </button>
            </div>
          )}
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 2: WORK CENTER CAPACITY HEATMAP                       */}
      {/* ============================================================== */}
      {subTab === "heatmap" && (
        <div className="space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
                <Activity className="w-4 h-4 text-rose-400" />
                <span>Oracle Capacity Utilization Heatmap & Shift Allocation</span>
              </h2>
              <p className="text-xs text-slate-400">
                Work center load percentages against finite shift hours. Highlights bottleneck resources before late orders occur.
              </p>
            </div>
            <div className="text-right text-xs font-mono">
              <span className="text-rose-400 font-bold block">Bottleneck: WC-CNC (88.4%)</span>
              <span className="text-slate-400 text-[10px]">Pacing Entire Austin Plant</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(enterpriseData?.workcenter_utilization || [
              { code: "WC-CNC", name: "5-Axis Precision Machining", utilization_pct: 88.4, status: "CRITICAL_BOTTLENECK" },
              { code: "WC-FAB", name: "Fiber Laser & Sheetmetal", utilization_pct: 74.2, status: "BALANCED" },
              { code: "WC-ASY", name: "Automated Pump Assembly", utilization_pct: 62.0, status: "HEALTHY" },
              { code: "WC-QC", name: "Zeiss CMM Quality Inspection", utilization_pct: 54.5, status: "OPEN_CAPACITY" },
            ]).map((wc: any) => {
              const isBottleneck = wc.utilization_pct > 80;
              return (
                <div key={wc.code} className="hairline-panel rounded-xl p-5 space-y-3.5 border border-white/[0.08]">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-white text-sm font-mono">{wc.code}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                            isBottleneck
                              ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                              : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                          }`}
                        >
                          {wc.status}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">{wc.name}</div>
                    </div>
                    <div className="text-right font-mono">
                      <span className={`text-xl font-bold ${isBottleneck ? "text-rose-400" : "text-emerald-400"}`}>
                        {wc.utilization_pct}%
                      </span>
                      <span className="text-[10px] text-slate-500 block">Horizon Load</span>
                    </div>
                  </div>

                  <div className="w-full bg-[#08090d] h-2.5 rounded-full overflow-hidden border border-white/[0.06]">
                    <div
                      className={`h-full rounded-full transition-all ${
                        isBottleneck ? "bg-rose-500" : "bg-emerald-500"
                      }`}
                      style={{ width: `${wc.utilization_pct}%` }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Shift Patterns & Planned Maintenance Windows */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div className="hairline-panel rounded-xl p-5 space-y-3 border border-white/[0.08]">
              <h3 className="font-bold text-xs text-slate-200 flex items-center space-x-2">
                <Calendar className="w-4 h-4 text-blue-400" />
                <span>Operating Shift Patterns (Austin Plant #1)</span>
              </h3>
              <div className="space-y-2 font-mono text-xs">
                {(enterpriseData?.shift_patterns || [
                  { shift: "Shift 1 (Day)", hours: "07:00 - 15:30", crews_on_duty: 12, status: "ACTIVE" },
                  { shift: "Shift 2 (Swing)", hours: "15:30 - 23:30", crews_on_duty: 8, status: "SCHEDULED" },
                  { shift: "Shift 3 (Night)", hours: "23:30 - 07:00", crews_on_duty: 4, status: "LIGHTS_OUT" },
                ]).map((s: any) => (
                  <div key={s.shift} className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex justify-between items-center">
                    <div>
                      <span className="text-slate-100 font-bold">{s.shift}</span>
                      <span className="text-slate-400 text-[11px] block">{s.hours} · {s.crews_on_duty} Operators</span>
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/20">
                      {s.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="hairline-panel rounded-xl p-5 space-y-3 border border-white/[0.08]">
              <h3 className="font-bold text-xs text-slate-200 flex items-center space-x-2">
                <Wrench className="w-4 h-4 text-amber-400" />
                <span>Planned Maintenance Windows (PM)</span>
              </h3>
              <div className="space-y-2 font-mono text-xs">
                {(enterpriseData?.planned_maintenance_windows || [
                  { machine_code: "CNC-01", window: "Sunday 02:00 - 06:00 (4h)", type: "Spindle Laser Calibration", status: "LOCKED_PREVENTATIVE" },
                  { machine_code: "LASER-01", window: "Saturday 22:00 - 00:00 (2h)", type: "Optical Lens Cleaning", status: "SCHEDULED" },
                ]).map((pm: any) => (
                  <div key={pm.machine_code} className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] space-y-1">
                    <div className="flex justify-between items-start">
                      <span className="text-amber-400 font-bold">{pm.machine_code} Maintenance</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
                        {pm.status}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300">{pm.type}</div>
                    <div className="text-[10px] text-slate-500">{pm.window}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 3: SECONDARY RESOURCE CONSTRAINTS (TOOLING & FIXTURES) */}
      {/* ============================================================== */}
      {subTab === "secondary" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
              <Hammer className="w-4 h-4 text-indigo-400" />
              <span>Secondary Resource Constraints: Tooling Fixtures & Certified Crews</span>
            </h2>
            <p className="text-xs text-slate-400">
              In Oracle Production Scheduling, an operation is dual-constrained: it binds both a Machine AND a specialized Tooling Fixture.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(enterpriseData?.secondary_resources || [
              { resource_code: "FIX-5AXIS-A", type: "Hydraulic Vise Fixture", bound_machine: "CNC-01", compatible_alloys: ["AL-6061", "TI-64"], status: "IN_USE" },
              { resource_code: "MOLD-INCONEL-01", type: "Ceramic Rigidity Chuck", bound_machine: "CNC-02", compatible_alloys: ["INCONEL-625"], status: "IN_USE" },
              { resource_code: "JIG-PMP-500", type: "Impeller Balancing Frame", bound_machine: "ASY-01", compatible_alloys: ["SS-316L"], status: "AVAILABLE" },
            ]).map((sr: any) => (
              <div key={sr.resource_code} className="hairline-panel rounded-xl p-5 space-y-3 border border-white/[0.08] font-mono text-xs">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-indigo-400 font-bold block">{sr.resource_code}</span>
                    <span className="text-[11px] text-slate-300 font-sans">{sr.type}</span>
                  </div>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      sr.status === "IN_USE"
                        ? "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                        : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                    }`}
                  >
                    {sr.status}
                  </span>
                </div>

                <div className="pt-2 border-t border-white/[0.06] space-y-1 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Bound Asset:</span>
                    <span className="text-slate-200 font-bold">{sr.bound_machine}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Compatible Alloys:</span>
                    <span className="text-blue-300">{sr.compatible_alloys.join(", ")}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 4: SEQUENCE-DEPENDENT SETUP MATRIX                     */}
      {/* ============================================================== */}
      {subTab === "matrix" && (
        <div className="space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
                <Wrench className="w-4 h-4 text-indigo-400" />
                <span>Sequence-Dependent Tooling & Changeover Matrix</span>
              </h2>
              <p className="text-xs text-slate-400">
                Visual proof of mathematical optimization. CP-SAT minimizes transition penalties between alloy grades to protect capacity.
              </p>
            </div>
            <div className="text-right text-xs font-mono">
              <span className="text-emerald-400 font-bold block">3.2 Hours Saved Today</span>
              <span className="text-slate-400 text-[10px]">Via Batch Setup Clustering</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-8 hairline-panel rounded-xl p-5 space-y-4">
              <div className="text-xs font-semibold text-slate-300 flex justify-between items-center border-b border-white/[0.08] pb-2">
                <span>TRANSITION PENALTY MATRIX (FROM ROW ➔ TO COLUMN)</span>
                <span className="text-[11px] font-mono text-slate-400">Values in Minutes (mins)</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-center text-xs font-mono">
                  <thead>
                    <tr className="text-slate-400 border-b border-white/[0.06]">
                      <th className="py-2.5 px-3 text-left font-sans">From Alloy \ To</th>
                      {setupMaterials.map((m) => (
                        <th key={m.code} className="py-2.5 px-3 text-slate-200">
                          {m.code}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {setupMaterials.map((fromMat) => (
                      <tr key={fromMat.code}>
                        <td className="py-3 px-3 text-left font-bold text-slate-200">
                          {fromMat.code}
                          <span className="text-[10px] text-slate-400 font-sans block">{fromMat.name}</span>
                        </td>
                        {setupMaterials.map((toMat) => {
                          const cell = setupMatrixData[fromMat.code]?.[toMat.code] || { time: 0, penalty: "MINIMAL", note: "" };
                          const isMinimal = cell.penalty === "MINIMAL";
                          const isModerate = cell.penalty === "MODERATE";

                          return (
                            <td key={toMat.code} className="py-2 px-2">
                              <button
                                onClick={() => setSelectedMatrixCell({ from: fromMat.name, to: toMat.name, time: cell.time, note: cell.note })}
                                className={`w-full py-2 px-3 rounded text-center transition-all cursor-pointer font-bold ${
                                  isMinimal
                                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20"
                                    : isModerate
                                    ? "bg-amber-500/10 text-amber-300 border border-amber-500/30 hover:bg-amber-500/20"
                                    : "bg-rose-500/10 text-rose-300 border border-rose-500/30 hover:bg-rose-500/20"
                                }`}
                              >
                                {cell.time}m
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center space-x-4 text-[11px] pt-2 border-t border-white/[0.06] text-slate-400">
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-emerald-500/40 border border-emerald-500"></span>
                  <span>10-20m Minimal (Same Alloy Batch)</span>
                </span>
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-amber-500/40 border border-amber-500"></span>
                  <span>35-55m Moderate (Tool & Coolant Reset)</span>
                </span>
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded bg-rose-500/40 border border-rose-500"></span>
                  <span>65-90m Critical (Full Degrease & Purge)</span>
                </span>
              </div>
            </div>

            <div className="lg:col-span-4 hairline-panel rounded-xl p-5 space-y-4">
              <h3 className="font-bold text-xs text-slate-200 flex items-center space-x-2">
                <Info className="w-4 h-4 text-indigo-400" />
                <span>Tooling & Setup Inspector</span>
              </h3>

              {selectedMatrixCell ? (
                <div className="p-4 rounded-lg bg-[#08090d] border border-indigo-500/30 space-y-3 font-mono text-xs animate-in fade-in duration-150">
                  <div className="text-slate-400 text-[11px]">Selected Transition:</div>
                  <div className="font-bold text-white text-sm">
                    {selectedMatrixCell.from} ➔ {selectedMatrixCell.to}
                  </div>
                  <div className="flex justify-between items-center py-2 border-y border-white/[0.06]">
                    <span className="text-slate-400">Downtime Penalty:</span>
                    <span className="text-base font-bold text-amber-400">{selectedMatrixCell.time} Minutes</span>
                  </div>
                  <div className="text-slate-300 font-sans text-xs leading-relaxed">
                    "{selectedMatrixCell.note}"
                  </div>
                </div>
              ) : (
                <div className="p-6 text-center text-slate-500 italic text-xs border border-dashed border-white/[0.08] rounded-lg">
                  Click any transition cell in the matrix to view the exact tooling and changeover protocol.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 5: MACHINE DIGITAL TWIN & IOT TELEMETRY               */}
      {/* ============================================================== */}
      {subTab === "telemetry" && (
        <div className="space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
                <Gauge className="w-4 h-4 text-emerald-400" />
                <span>Shop-Floor Digital Twin & Live Machine IoT Telemetry</span>
              </h2>
              <p className="text-xs text-slate-400">
                Direct integration with machine controllers (Fanuc, Siemens Sinumerik, Heidenhain). Schedule reflects physical spindle health.
              </p>
            </div>
            <div className="flex items-center space-x-2 text-xs font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span className="text-slate-300">OPC-UA / MQTT Feed Active</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {machineTelemetry.map((m) => {
              const isWarning = m.wearStatus === "WARNING";
              const isRunning = m.status === "RUNNING";

              return (
                <div
                  key={m.code}
                  className={`hairline-panel rounded-xl p-4.5 space-y-3.5 border transition-all ${
                    isWarning ? "border-amber-500/40 bg-amber-950/10" : "border-white/[0.08]"
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-white text-sm font-mono">{m.code}</span>
                        <span
                          className={`px-1.5 py-0.2 rounded text-[10px] font-bold font-mono ${
                            isRunning
                              ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                              : "bg-slate-500/10 text-slate-400 border border-slate-500/30"
                          }`}
                        >
                          {m.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 font-sans mt-0.5">{m.name}</div>
                    </div>
                    {isWarning && (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold">
                        Tool Alert (94%)
                      </span>
                    )}
                  </div>

                  <div className="p-2 rounded bg-[#08090d] border border-white/[0.06] text-xs font-mono">
                    <span className="text-[10px] text-slate-500 block">Current Operation:</span>
                    <span className="text-slate-200 font-medium truncate block">{m.op}</span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-center">
                    <div className="bg-[#08090d] p-2 rounded border border-white/[0.04]">
                      <span className="text-[9px] text-slate-500 block">Spindle</span>
                      <span className="text-slate-200 font-bold">{m.rpm > 0 ? `${m.rpm} RPM` : "0"}</span>
                    </div>
                    <div className="bg-[#08090d] p-2 rounded border border-white/[0.04]">
                      <span className="text-[9px] text-slate-500 block">Temp</span>
                      <span className="text-slate-200 font-bold">{m.temp}</span>
                    </div>
                    <div className="bg-[#08090d] p-2 rounded border border-white/[0.04]">
                      <span className="text-[9px] text-slate-500 block">Vibration</span>
                      <span className="text-slate-200 font-bold">{m.vibration}</span>
                    </div>
                  </div>

                  <div className="space-y-1 font-mono text-[10px]">
                    <div className="flex justify-between text-slate-400">
                      <span>Carbide Tool Wear Index:</span>
                      <span className={isWarning ? "text-amber-400 font-bold" : "text-slate-200"}>
                        {m.toolWear}% / 100%
                      </span>
                    </div>
                    <div className="w-full bg-[#08090d] h-2 rounded-full overflow-hidden border border-white/[0.06]">
                      <div
                        className={`h-full rounded-full transition-all ${
                          isWarning ? "bg-amber-500" : "bg-emerald-500"
                        }`}
                        style={{ width: `${m.toolWear}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 6: WHAT-IF DISRUPTION COPILOT                          */}
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
                className="text-xs text-emerald-300 hover:text-white px-2.5 py-1 bg-emerald-900/40 rounded border border-emerald-700/50 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

            <div className="lg:col-span-2 space-y-4">
              {props.disruptionResult && activeScenario ? (
                <div className="hairline-panel-elevated rounded-xl p-6 space-y-5 animate-in fade-in duration-200">
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
                            className={`p-3.5 rounded-lg text-left border transition-all flex flex-col justify-between cursor-pointer ${
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
      {/* SUB-TAB 7: PHYSICAL STOCK & INVENTORY HEALTH (SAP MMBE)        */}
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
                  className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer ${
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
                className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors ml-2 cursor-pointer"
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
      {/* SUB-TAB 8: SOX PLANT AUDIT TRAIL                               */}
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
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors cursor-pointer"
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
