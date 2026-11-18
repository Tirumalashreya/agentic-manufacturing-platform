// frontend/src/components/ExecutiveStation.tsx
import React from "react";
import {
  TrendingUp,
  Activity,
  ShieldCheck,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  PieChart,
  BarChart3,
  Download,
} from "lucide-react";

interface ExecutiveStationProps {
  salesOrders: any[];
  materials: any[];
  ganttData: any;
  invoices: any[];
  exportToCsv: (filename: string, rows: Record<string, any>[]) => void;
}

export default function ExecutiveStation(props: ExecutiveStationProps) {
  const totalPipeline = props.salesOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
  const totalInvoiced = props.invoices.reduce((sum, i) => sum + (i.amount || 0), 0);
  const totalPaid = props.invoices.filter((i) => i.status === "PAID").reduce((sum, i) => sum + (i.amount || 0), 0);
  const inventoryValuation = props.materials.reduce((sum, m) => sum + m.current_stock * m.cost_per_unit, 0);

  return (
    <div className="space-y-6">
      {/* Station Ribbon */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d1017] p-4 rounded-xl border border-purple-500/20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400 font-bold">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-purple-400">
                Seat 4 · Executive & Operations Intelligence
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-300 border border-purple-500/20">
                Enterprise S&OP Radar
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight mt-0.5">
              Executive Supply Chain Telemetry & Commercial Radar
            </h1>
          </div>
        </div>

        <div className="flex items-center space-x-3 text-xs">
          <div className="text-right">
            <div className="font-semibold text-slate-200">Executive VP / COO</div>
            <div className="text-slate-400 text-[11px] font-mono">Global Operations Leadership</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-300 font-bold text-xs">
            VP
          </div>
        </div>
      </div>

      {/* High-Level Telemetry Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="hairline-panel p-5 rounded-xl">
          <span className="text-xs text-slate-400 font-mono block">ON-TIME IN-FULL (OTIF)</span>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">98.4%</div>
          <span className="text-[11px] text-emerald-500 font-medium">↑ +2.1% this quarter (World Class)</span>
        </div>

        <div className="hairline-panel p-5 rounded-xl">
          <span className="text-xs text-slate-400 font-mono block">PLANT OEE AVERAGE</span>
          <div className="text-2xl font-bold font-mono text-blue-400 mt-1">87.2%</div>
          <span className="text-[11px] text-slate-400">9 Active Machines Across 4 Centers</span>
        </div>

        <div className="hairline-panel p-5 rounded-xl">
          <span className="text-xs text-slate-400 font-mono block">CUSTOMER PROMISE BREACHES</span>
          <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">0 Breach</div>
          <span className="text-[11px] text-slate-400">100% CTP Feasibility Safeguarded</span>
        </div>

        <div className="hairline-panel p-5 rounded-xl">
          <span className="text-xs text-slate-400 font-mono block">COMMERCIAL PIPELINE VALUE</span>
          <div className="text-2xl font-bold font-mono text-slate-100 mt-1">${totalPipeline.toLocaleString()}</div>
          <span className="text-[11px] text-blue-400 font-mono">{props.salesOrders.length} Confirmed Contracts</span>
        </div>
      </div>

      {/* Financial & Material Asset Split */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
          <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <span>Revenue & Invoicing Realization</span>
          </h2>

          <div className="space-y-3 font-mono text-xs">
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Total Booked Sales Contracts:</span>
              <span className="text-slate-100 font-bold">${totalPipeline.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Billed Invoices Dispatched:</span>
              <span className="text-blue-400 font-bold">${totalInvoiced.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Cash Received / Settled:</span>
              <span className="text-emerald-400 font-bold">${totalPaid.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Open Receivables:</span>
              <span className="text-amber-400 font-bold">${(totalInvoiced - totalPaid).toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
          <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
            <Activity className="w-4 h-4 text-blue-400" />
            <span>Working Capital & Plant Stock Valuation</span>
          </h2>

          <div className="space-y-3 font-mono text-xs">
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Total Material Stock Valuation:</span>
              <span className="text-slate-100 font-bold">${inventoryValuation.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Tracked SKU Catalog Count:</span>
              <span className="text-blue-400 font-bold">{props.materials.length} Master SKUs</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Inventory Turnover Ratio (Annualized):</span>
              <span className="text-emerald-400 font-bold">14.2x (Tier-1 Benchmark)</span>
            </div>
            <div className="flex justify-between items-center p-3 rounded bg-[#0a0b0e] border border-white/[0.06]">
              <span className="text-slate-400">Safety Buffer Coverage:</span>
              <span className="text-slate-200 font-bold">99.4% Across All BOM Levels</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
