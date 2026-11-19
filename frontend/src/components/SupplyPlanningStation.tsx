// frontend/src/components/SupplyPlanningStation.tsx
import React, { useState } from "react";
import {
  Boxes,
  Cpu,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Download,
  Layers,
  Truck,
  FileText,
  ChevronRight,
  Search,
  Building2,
  DollarSign,
  Clock,
  ShieldCheck,
  PackageCheck,
  Workflow,
  ArrowRight,
  BookOpen,
  Info,
} from "lucide-react";

interface SupplyPlanningStationProps {
  mrpData: any;
  runningMrp: boolean;
  mrpMessage: string | null;
  setMrpMessage: (v: string | null) => void;
  handleRunMrp: () => Promise<void>;
  mrpFilterStatus: "ALL" | "SHORTAGES" | "HEALTHY";
  setMrpFilterStatus: (v: "ALL" | "SHORTAGES" | "HEALTHY") => void;
  filteredMrpItems: any[];
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  handleApprovePo: (poId: string) => Promise<void>;
  handleReceivePo: (poId: string) => Promise<void>;
  actionLoading: string | null;
  exportToCsv: (filename: string, rows: Record<string, any>[]) => void;
  salesOrdersCount: number;
}

export default function SupplyPlanningStation(props: SupplyPlanningStationProps) {
  const [subTab, setSubTab] = useState<"requirements" | "orders" | "bom" | "suppliers">("requirements");
  const [showSapGuide, setShowSapGuide] = useState(false);

  const purchaseOrders = props.mrpData?.purchase_orders || [];
  const openPrCount = purchaseOrders.filter((po: any) => po.status === "DRAFT_PR").length;
  const releasedPoCount = purchaseOrders.filter((po: any) => po.status === "RELEASED").length;
  const receivedPoCount = purchaseOrders.filter((po: any) => po.status === "RECEIVED").length;
  const shortagesCount = props.mrpData?.shortages_detected_count || 0;

  return (
    <div className="space-y-6">
      {/* Role & Station Identification Ribbon */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d1017] p-4 rounded-xl border border-emerald-500/20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
            <Boxes className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                Seat 3 · Procurement & Supply Planning Workstation
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                Oracle Supply Planning Cloud (MRP)
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight mt-0.5">
              Autonomous Material Requirements & Strategic Sourcing Console
            </h1>
          </div>
        </div>

        {/* Buyer Persona & Guide Button */}
        <div className="flex items-center space-x-3 text-xs">
          <button
            onClick={() => setShowSapGuide(!showSapGuide)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/50 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-500/30 transition-all cursor-pointer font-mono text-[11px] whitespace-nowrap"
            title="View translation guide from legacy SAP MD01N / MD04"
          >
            <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span>{showSapGuide ? "Hide SAP Guide" : "Switching from SAP MRP? (Guide)"}</span>
          </button>

          <div className="text-right border-l border-white/[0.08] pl-3">
            <div className="font-semibold text-slate-200">Elena Rostova</div>
            <div className="text-slate-400 text-[11px] font-mono">Lead Supply Planner & Global Buyer</div>
          </div>
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 font-bold text-xs">
            ER
          </div>
        </div>
      </div>

      {/* SAP / Oracle Transition Guide for Supply Planners */}
      {showSapGuide && (
        <div className="p-5 rounded-xl bg-gradient-to-r from-emerald-950/60 to-[#0e111a] border border-emerald-500/30 text-xs space-y-3 animate-in fade-in duration-200">
          <div className="flex justify-between items-start">
            <div className="flex items-center space-x-2 text-emerald-300 font-bold text-sm">
              <Info className="w-4 h-4" />
              <span>Supply Planner Guide: How This Replaces Legacy SAP MD01N & Old MRP Runs</span>
            </div>
            <button
              onClick={() => setShowSapGuide(false)}
              className="text-slate-400 hover:text-white font-mono text-xs px-2 py-0.5 bg-white/[0.04] rounded cursor-pointer"
            >
              ✕ Close
            </button>
          </div>

          <p className="text-slate-300 leading-relaxed">
            In traditional systems like <strong>SAP ERP (MD01N / MD04 / ME21N)</strong>, Material Buyers and SCM Planners suffered from:
            <strong> (1) Overnight batch MRP runs</strong> that meant acting on 12-hour-old data,
            <strong> (2) Clunky tree navigators</strong> across multiple screens just to trace which component was short, and
            <strong> (3) Manual Purchase Requisition generation</strong> (ME51N) followed by manual PO release (ME21N). Here is your modernized experience:
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 font-mono text-[11px]">
            <div className="p-3 rounded-lg bg-[#08090d] border border-white/[0.08] space-y-1">
              <span className="text-rose-400 font-bold block">OLD SAP MD01N</span>
              <div className="text-slate-400">Overnight batch netting, cryptic MD04 stock requirement trees, and manual calculation of engineering scrap factors.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-emerald-500/30 space-y-1">
              <span className="text-emerald-300 font-bold block">AUTONOMOUS MULTI-LEVEL MRP</span>
              <div className="text-slate-300">Explodes multi-level BOMs in 1-click. Applies scrap factors (2% CNC, 3.5% laser) and computes deterministic net requirements instantaneously.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-blue-500/30 space-y-1">
              <span className="text-blue-400 font-bold block">CLOSED-LOOP PROCUREMENT</span>
              <div className="text-slate-300">Auto-generates Purchase Requisitions with lead-time dock dates. 1-click PO release (ME21N) and 1-click MIGO 101 Goods Receipt.</div>
            </div>
          </div>
        </div>
      )}

      {/* SCM Telemetry Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">PEGGED DEMAND ORDERS</span>
          <div className="text-xl font-bold font-mono text-slate-100 mt-1">
            {props.mrpData?.demand_orders_count || props.salesOrdersCount || 5} Orders
          </div>
          <span className="text-[10px] text-slate-400">Firm Commercial Commitments</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">COMPONENTS EXPLODED</span>
          <div className="text-xl font-bold font-mono text-blue-400 mt-1">
            {props.mrpData?.components_analyzed || 6} Items
          </div>
          <span className="text-[10px] text-slate-400">Multi-Level BOM Trees</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">NET SHORTAGES</span>
          <div className={`text-xl font-bold font-mono mt-1 ${shortagesCount > 0 ? "text-rose-400" : "text-emerald-400"}`}>
            {shortagesCount} Shortage(s)
          </div>
          <span className="text-[10px] text-slate-400">Gross + Safety - Available</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">PO PIPELINE</span>
          <div className="text-xl font-bold font-mono text-amber-400 mt-1">
            {openPrCount} PRs / {releasedPoCount} In Flight
          </div>
          <span className="text-[10px] text-emerald-400">{receivedPoCount} Received at Dock</span>
        </div>
      </div>

      {/* Sub-Navigation & Actions */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-white/[0.08] pb-2">
        <div className="flex space-x-1 overflow-x-auto">
          <button
            onClick={() => setSubTab("requirements")}
            className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              subTab === "requirements"
                ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.04]"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Boxes className="w-4 h-4" />
            <span>Net Requirements (MD01N)</span>
            {shortagesCount > 0 && (
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-500/20 text-rose-300 font-mono font-bold">
                {shortagesCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setSubTab("orders")}
            className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              subTab === "orders"
                ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.04]"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <PackageCheck className="w-4 h-4" />
            <span>Purchase Orders & Dock (ME21N / MIGO)</span>
            {openPrCount > 0 && (
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-300 font-mono font-bold">
                {openPrCount} PRs
              </span>
            )}
          </button>

          <button
            onClick={() => setSubTab("bom")}
            className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              subTab === "bom"
                ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.04]"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Workflow className="w-4 h-4" />
            <span>Multi-Level BOM Explorer (CS03)</span>
          </button>

          <button
            onClick={() => setSubTab("suppliers")}
            className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium border-b-2 transition-all cursor-pointer whitespace-nowrap ${
              subTab === "suppliers"
                ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.04]"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Truck className="w-4 h-4" />
            <span>Certified Suppliers Roster</span>
          </button>
        </div>

        {/* Global MRP Trigger Button */}
        <button
          onClick={props.handleRunMrp}
          disabled={props.runningMrp}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-lg text-xs shadow-sm flex items-center space-x-2 transition-all cursor-pointer whitespace-nowrap"
        >
          {props.runningMrp ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Exploding BOMs & Sourcing Components...</span>
            </>
          ) : (
            <>
              <Cpu className="w-3.5 h-3.5" />
              <span>Execute Multi-Level MRP Run (MD01N)</span>
            </>
          )}
        </button>
      </div>

      {/* MRP Feedback Banner */}
      {props.mrpMessage && (
        <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 text-emerald-100 flex items-center justify-between shadow-xl animate-in fade-in duration-200">
          <div className="flex items-center space-x-3 text-xs">
            <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
              ✓
            </div>
            <span className="font-mono text-slate-200">{props.mrpMessage}</span>
          </div>
          <button
            onClick={() => props.setMrpMessage(null)}
            className="text-xs text-emerald-300 hover:text-white px-2 py-0.5 bg-emerald-900/40 rounded border border-emerald-700/50 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 1: NET REQUIREMENTS MATRIX (SAP MD01N)                 */}
      {/* ============================================================== */}
      {subTab === "requirements" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Material Net Requirements Matrix</h2>
              <p className="text-xs text-slate-400">
                Formula: Net Requirement = max(0, Gross Demand + Safety Stock - Current On-Hand).
              </p>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <span className="text-slate-400 font-mono text-[11px] mr-1">Filter:</span>
              {[
                { label: `All Items (${props.mrpData?.items?.length || 0})`, val: "ALL" as const },
                { label: `Shortages (${shortagesCount})`, val: "SHORTAGES" as const },
                { label: "Healthy", val: "HEALTHY" as const },
              ].map((f) => (
                <button
                  key={f.val}
                  onClick={() => props.setMrpFilterStatus(f.val)}
                  className={`px-2.5 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                    props.mrpFilterStatus === f.val
                      ? "bg-emerald-600 text-white font-semibold"
                      : "bg-white/[0.04] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <button
                onClick={() => {
                  const rows = (props.filteredMrpItems || []).map((i) => ({
                    SKU: i.sku,
                    Name: i.name,
                    Material_Type: i.material_type,
                    Gross_Requirement: i.gross_requirement,
                    Current_Stock: i.current_stock,
                    Safety_Stock: i.safety_stock,
                    Net_Requirement: i.net_requirement,
                    Status: i.status,
                    Supplier: i.supplier_name,
                    Lead_Time_Days: i.supplier_lead_time_days,
                  }));
                  props.exportToCsv("mrp_net_requirements.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors ml-2 cursor-pointer"
              >
                <Download className="w-3 h-3 text-emerald-400" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">SKU / COMPONENT</th>
                  <th className="py-2.5 px-4 font-semibold">TYPE</th>
                  <th className="py-2.5 px-4 font-semibold text-right">GROSS DEMAND</th>
                  <th className="py-2.5 px-4 font-semibold text-right">AVAILABLE</th>
                  <th className="py-2.5 px-4 font-semibold text-right">SAFETY</th>
                  <th className="py-2.5 px-4 font-semibold text-right">NET REQ</th>
                  <th className="py-2.5 px-4 font-semibold">LEAD TIME</th>
                  <th className="py-2.5 px-4 font-semibold">PREFERRED SUPPLIER</th>
                  <th className="py-2.5 px-4 font-semibold">STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.filteredMrpItems.length > 0 ? (
                  props.filteredMrpItems.map((item: any) => {
                    const isShortage = item.status === "SHORTAGE_DETECTED";
                    return (
                      <tr key={item.sku} className="hover:bg-white/[0.02]">
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-200">{item.sku}</div>
                          <div className="text-[11px] text-slate-400 font-sans">{item.name}</div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/[0.04] text-slate-300 border border-white/[0.06]">
                            {item.material_type}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right text-slate-300 font-bold">{item.gross_requirement}</td>
                        <td className="py-3 px-4 text-right text-slate-400">{item.current_stock}</td>
                        <td className="py-3 px-4 text-right text-slate-400">{item.safety_stock}</td>
                        <td className={`py-3 px-4 text-right font-bold ${isShortage ? "text-rose-400 text-sm" : "text-emerald-400"}`}>
                          {item.net_requirement}
                        </td>
                        <td className="py-3 px-4 text-slate-300">{item.supplier_lead_time_days} days</td>
                        <td className="py-3 px-4 text-slate-300 font-sans">{item.supplier_name || "—"}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                              isShortage
                                ? "bg-rose-500/10 text-rose-300 border border-rose-500/30"
                                : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                            }`}
                          >
                            {isShortage ? "Shortage Detected" : "Healthy"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-500 italic">
                      Click "Execute Multi-Level MRP Run" to explode active demand and calculate component net requirements.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 2: PURCHASE ORDERS & DOCK RECEIPT (ME21N / MIGO 101)   */}
      {/* ============================================================== */}
      {subTab === "orders" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Purchase Orders & Inbound Receiving Dock</h2>
              <p className="text-xs text-slate-400">
                End-to-end procurement lifecycle: Draft PR → Released to Vendor (ME21N) → Physical Dock Receipt (MIGO 101).
              </p>
            </div>
            <button
              onClick={() => {
                const rows = purchaseOrders.map((po: any) => ({
                  PO_Number: po.po_number,
                  SKU: po.material_sku,
                  Material_Name: po.material_name,
                  Quantity: po.quantity,
                  Total_Cost: po.total_cost,
                  Supplier: po.supplier_name,
                  Lead_Time_Days: po.lead_time_days,
                  Expected_Arrival: po.expected_delivery_date,
                  Status: po.status,
                }));
                props.exportToCsv("procurement_purchase_orders.csv", rows);
              }}
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors cursor-pointer"
            >
              <Download className="w-3 h-3 text-emerald-400" />
              <span>Export PO Ledger (CSV)</span>
            </button>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">PO NUMBER</th>
                  <th className="py-2.5 px-4 font-semibold">MATERIAL / SKU</th>
                  <th className="py-2.5 px-4 font-semibold text-right">QUANTITY</th>
                  <th className="py-2.5 px-4 font-semibold text-right">TOTAL COST</th>
                  <th className="py-2.5 px-4 font-semibold">SUPPLIER</th>
                  <th className="py-2.5 px-4 font-semibold">EXPECTED DOCK DUE</th>
                  <th className="py-2.5 px-4 font-semibold">STATUS</th>
                  <th className="py-2.5 px-4 font-semibold text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {purchaseOrders.length > 0 ? (
                  purchaseOrders.map((po: any) => {
                    const isDraft = po.status === "DRAFT_PR";
                    const isReleased = po.status === "RELEASED";
                    const isReceived = po.status === "RECEIVED";
                    const isLoading = props.actionLoading === po.id;

                    return (
                      <tr key={po.id} className="hover:bg-white/[0.02]">
                        <td className="py-3 px-4 font-bold text-slate-200">{po.po_number}</td>
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-200">{po.material_sku}</div>
                          <div className="text-[11px] text-slate-400 font-sans">{po.material_name}</div>
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-slate-200">{po.quantity}</td>
                        <td className="py-3 px-4 text-right text-emerald-400 font-semibold">${po.total_cost?.toLocaleString()}</td>
                        <td className="py-3 px-4 text-slate-300 font-sans">{po.supplier_name}</td>
                        <td className="py-3 px-4 text-slate-400">
                          {po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString() : "—"}
                        </td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                              isDraft
                                ? "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                                : isReleased
                                ? "bg-blue-500/10 text-blue-300 border border-blue-500/30"
                                : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                            }`}
                          >
                            {isDraft ? "Draft PR" : isReleased ? "Released (In Flight)" : "Dock Received (101)"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {isDraft && (
                            <button
                              onClick={() => props.handleApprovePo(po.id)}
                              disabled={isLoading}
                              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-[11px] font-semibold transition-all shadow-sm cursor-pointer"
                            >
                              {isLoading ? "Releasing..." : "Release PO (ME21N)"}
                            </button>
                          )}
                          {isReleased && (
                            <button
                              onClick={() => props.handleReceivePo(po.id)}
                              disabled={isLoading}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded text-[11px] font-semibold transition-all shadow-sm cursor-pointer"
                            >
                              {isLoading ? "Posting GR..." : "Receive at Dock (MIGO 101)"}
                            </button>
                          )}
                          {isReceived && (
                            <span className="text-[11px] text-emerald-400 font-semibold flex items-center justify-end space-x-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Inventory Stocked</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-slate-500 italic">
                      Zero active Purchase Orders. Run the autonomous MRP engine to generate supply replenishment orders.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 3: MULTI-LEVEL BOM HIERARCHY EXPLORER (SAP CS03)       */}
      {/* ============================================================== */}
      {subTab === "bom" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight">Multi-Level Engineering Bill of Materials (CS03)</h2>
            <p className="text-xs text-slate-400">
              Recursive parent-child structure with engineering scrap allowances and certified supply sources.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* PMP-500 BOM Tree */}
            <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
              <div className="flex justify-between items-start border-b border-white/[0.06] pb-3">
                <div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">
                    FINISHED GOOD (LEVEL 0)
                  </span>
                  <h3 className="text-sm font-bold text-white mt-1">PMP-500: Industrial Multi-Stage Impeller Pump</h3>
                  <p className="text-[11px] text-slate-400">High-pressure chemical & oil transfer pump assembly</p>
                </div>
                <span className="text-xs font-mono font-bold text-emerald-400">$1,850 Standard Cost</span>
              </div>

              <div className="space-y-2 font-mono text-xs">
                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ ASY-SUB-01</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">Impeller Rotor Core Assembly</span>
                    <div className="text-[10px] text-slate-400">Level 1 Sub-Assembly · Scrap: 1.5% · WC-ASY</div>
                  </div>
                  <span className="text-slate-300">Qty: 1.0 EA</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between ml-4">
                  <div>
                    <span className="text-indigo-400 font-bold">└─ RAW-AL-6061</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">Billet 6061 Aerospace Aluminum</span>
                    <div className="text-[10px] text-slate-400">Level 2 Raw · Scrap: 2.0% CNC · Alcoa Aerospace</div>
                  </div>
                  <span className="text-slate-300">Qty: 12.5 KG</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between ml-4">
                  <div>
                    <span className="text-indigo-400 font-bold">└─ COMP-BRG-SKF</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">SKF Precision Roller Bearings</span>
                    <div className="text-[10px] text-slate-400">Level 2 Component · Scrap: 0.0% · Timken Bearings</div>
                  </div>
                  <span className="text-slate-300">Qty: 2.0 EA</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ RAW-SS-316L</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">Stainless 316L Laser Plate</span>
                    <div className="text-[10px] text-slate-400">Level 1 Raw · Scrap: 3.5% Kerf · Outokumpu Stainless</div>
                  </div>
                  <span className="text-slate-300">Qty: 8.0 KG</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ COMP-FAST-M8</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">M8 Grade 10.9 Flange Bolts</span>
                    <div className="text-[10px] text-slate-400">Level 1 Fastener · Scrap: 1.0% · Precision Fasteners</div>
                  </div>
                  <span className="text-slate-300">Qty: 24.0 EA</span>
                </div>
              </div>
            </div>

            {/* PMP-200 BOM Tree */}
            <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
              <div className="flex justify-between items-start border-b border-white/[0.06] pb-3">
                <div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">
                    FINISHED GOOD (LEVEL 0)
                  </span>
                  <h3 className="text-sm font-bold text-white mt-1">PMP-200: Standard Centrifugal Utility Pump</h3>
                  <p className="text-[11px] text-slate-400">Commercial grade cooling & HVAC circulating pump</p>
                </div>
                <span className="text-xs font-mono font-bold text-emerald-400">$940 Standard Cost</span>
              </div>

              <div className="space-y-2 font-mono text-xs">
                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ RAW-AL-6061</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">Billet 6061 Cast Housing</span>
                    <div className="text-[10px] text-slate-400">Level 1 Raw · Scrap: 2.0% CNC · Alcoa Aerospace</div>
                  </div>
                  <span className="text-slate-300">Qty: 6.0 KG</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ COMP-SEAL-VITON</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">Viton Chemical Seal Ring</span>
                    <div className="text-[10px] text-slate-400">Level 1 Component · Scrap: 0.0% · Parker Hannifin</div>
                  </div>
                  <span className="text-slate-300">Qty: 1.0 EA</span>
                </div>

                <div className="p-2.5 rounded bg-[#0a0b0e] border border-white/[0.06] flex items-center justify-between">
                  <div>
                    <span className="text-blue-400 font-bold">└─ COMP-FAST-M8</span>
                    <span className="text-slate-300 ml-2 font-sans font-medium">M8 Grade 10.9 Flange Bolts</span>
                    <div className="text-[10px] text-slate-400">Level 1 Fastener · Scrap: 1.0% · Precision Fasteners</div>
                  </div>
                  <span className="text-slate-300">Qty: 12.0 EA</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* SUB-TAB 4: CERTIFIED SUPPLIER ROSTER & PERFORMANCE            */}
      {/* ============================================================== */}
      {subTab === "suppliers" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight">Approved & Certified Supplier Roster</h2>
            <p className="text-xs text-slate-400">
              Contracted supplier master with quality compliance ratings, contracted lead times, and on-time performance (OTD).
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                name: "Alcoa Aerospace Metals",
                code: "SUP-ALCOA-01",
                category: "Raw Billet Aluminum 6061-T6",
                leadTime: "3 Days",
                otd: "99.2%",
                rating: "Tier-1 Certified",
                cert: "AS9100D / ISO 9001",
              },
              {
                name: "Outokumpu Stainless USA",
                code: "SUP-OUTO-02",
                category: "Sheet & Plate SS-316L",
                leadTime: "5 Days",
                otd: "98.7%",
                rating: "Tier-1 Certified",
                cert: "ISO 9001:2015",
              },
              {
                name: "Timken Bearing Corporation",
                code: "SUP-TIMKEN-03",
                category: "Precision Roller & Ball Bearings",
                leadTime: "7 Days",
                otd: "97.5%",
                rating: "Tier-1 Certified",
                cert: "ISO/TS 16949",
              },
              {
                name: "Parker Hannifin Seals",
                code: "SUP-PARKER-04",
                category: "Viton & Fluoropolymer O-Rings",
                leadTime: "4 Days",
                otd: "99.8%",
                rating: "Preferred Vendor",
                cert: "FDA / ISO 14001",
              },
              {
                name: "Precision Fasteners Ltd",
                code: "SUP-PREC-05",
                category: "Grade 10.9 Structural Hardware",
                leadTime: "2 Days",
                otd: "99.5%",
                rating: "Preferred Vendor",
                cert: "ISO 9001:2015",
              },
            ].map((sup) => (
              <div key={sup.code} className="hairline-panel rounded-xl p-5 space-y-3 border border-white/[0.08]">
                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {sup.rating}
                    </span>
                    <h3 className="text-sm font-bold text-white mt-1.5">{sup.name}</h3>
                    <div className="text-[11px] text-slate-400 font-mono">{sup.code}</div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-mono font-bold text-emerald-400 block">{sup.otd}</span>
                    <span className="text-[10px] text-slate-400">OTD Metric</span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs border-t border-white/[0.06] pt-3">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Commodity:</span>
                    <span className="text-slate-200 font-medium">{sup.category}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Contract Lead Time:</span>
                    <span className="text-slate-200 font-mono font-semibold">{sup.leadTime}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Quality Standard:</span>
                    <span className="text-blue-400 font-mono text-[11px]">{sup.cert}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
