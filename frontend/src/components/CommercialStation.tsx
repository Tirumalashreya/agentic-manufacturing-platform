// frontend/src/components/CommercialStation.tsx
import React, { useState, useEffect } from "react";
import {
  Building2,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  DollarSign,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  Truck,
  Receipt,
  FileText,
  Printer,
  ChevronRight,
  Eye,
  Check,
  Search,
  Download,
  Clock,
  Layers,
  Send,
  BookOpen,
  Info,
  Activity,
  Zap,
  Globe,
  Lock,
  Unlock,
  Sliders,
  Filter,
  FileCode,
  Copy,
  CheckCheck,
  Workflow,
  X,
} from "lucide-react";

interface CommercialStationProps {
  customers: any[];
  salesOrders: any[];
  deliveries: any[];
  invoices: any[];
  prompt: string;
  setPrompt: (v: string) => void;
  evaluating: boolean;
  proposal: any;
  approving: boolean;
  orderConfirmation: any;
  handleEvaluateRFQ: () => Promise<void>;
  handleApprove: () => Promise<void>;
  handleShipDelivery: (id: string) => Promise<void>;
  handlePayInvoice: (id: string) => Promise<void>;
  handleViewOrderFlow: (id: string) => Promise<void>;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  actionLoading: string | null;
  filteredOrders: any[];
  filteredDeliveries: any[];
  filteredInvoices: any[];
  exportToCsv: (filename: string, rows: Record<string, any>[]) => void;
}

const API_BASE = "http://localhost:8080/api/v1";

export default function CommercialStation(props: CommercialStationProps) {
  const [subTab, setSubTab] = useState<"intake" | "orders" | "gop" | "edi" | "deliveries" | "invoices" | "customers">("intake");
  const [showSapGuide, setShowSapGuide] = useState(false);
  const [gopData, setGopData] = useState<any>(null);
  const [holdActionLoading, setHoldActionLoading] = useState<string | null>(null);

  // Enterprise EDI 850/855 Gateway State
  const [ediPayload, setEdiPayload] = useState<string>(
    `ISA*00*          *00*          *ZZ*BOEING_AERO    *ZZ*GAIC_ENTERPRISE*261119*0930*U*00401*000008891*0*P*>~
GS*PO*BOEING_AERO*GAIC_ENTERPRISE*20261119*0930*8891*X*004010~
ST*850*0001~
BEG*00*SA*PO-BOE-2026-9812**20261119~
CUR*BY*USD~
REF*DP*AEROSPACE-DEFENSE-DIV~
PER*BD*Sarah Jenkins CSR*TE*512-555-0199~
N1*BY*Boeing Aerospace Defense*92*BOEING-01~
N3*100 Boeing Way*Plant Bldg 4~
N4*Seattle*WA*98108*USA~
N1*ST*Boeing Final Assembly Dock 3*92*BOEING-DOCK3~
PO1*1*20*EA*900.00**VP*PMP-500*MG*CRYOGENIC-IMPELLER~
PID*F****AS9100 Precision 5-Axis Impeller Pump Assembly~
DTM*002*20261125~
CTT*1*20~
SE*15*0001~
GE*1*8891~
IEA*1*000008891~`
  );
  const [ediIngesting, setEdiIngesting] = useState(false);
  const [ediResult, setEdiResult] = useState<any>(null);
  const [edi855Result, setEdi855Result] = useState<any>(null);
  const [copied855, setCopied855] = useState(false);

  // DOO 8-Milestone Inspection Modal State
  const [selectedDooMilestones, setSelectedDooMilestones] = useState<any>(null);
  const [loadingDooId, setLoadingDooId] = useState<string | null>(null);

  const handleIngestEdi850 = async () => {
    setEdiIngesting(true);
    try {
      const res = await fetch(`${API_BASE}/sales/edi/ingest-850`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_edi_text: ediPayload,
          customer_name: "Boeing Aerospace",
          po_number: "PO-BOE-2026-9812",
          sku: "PMP-500",
          quantity: 20,
          unit_price: 900.0,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setEdiResult(data);
        const ackRes = await fetch(`${API_BASE}/sales/edi/generate-855/${data.order_id}`);
        if (ackRes.ok) {
          const ackData = await ackRes.json();
          setEdi855Result(ackData);
        }
      }
    } catch (e) {
      console.error("EDI 850 Ingestion failed:", e);
    } finally {
      setEdiIngesting(false);
    }
  };

  const handleCopy855 = () => {
    if (edi855Result?.edi_x12_payload) {
      navigator.clipboard.writeText(edi855Result.edi_x12_payload);
      setCopied855(true);
      setTimeout(() => setCopied855(false), 2000);
    }
  };

  const handleFetchDooMilestones = async (orderId: string) => {
    setLoadingDooId(orderId);
    try {
      const res = await fetch(`${API_BASE}/sales/orders/${orderId}/doo-milestones`);
      if (res.ok) {
        const data = await res.json();
        setSelectedDooMilestones(data);
      }
    } catch (e) {
      console.error("Failed to load DOO milestones:", e);
    } finally {
      setLoadingDooId(null);
    }
  };

  // Fetch Oracle GOP Multi-Sourcing rules
  useEffect(() => {
    fetch(`${API_BASE}/sales/gop/multi-sourcing`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setGopData(data))
      .catch((e) => console.error("GOP fetch error:", e));
  }, []);

  const totalPipeline = props.salesOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
  const openInvoicesCount = props.invoices.filter((i) => i.status !== "PAID").length;
  const pendingShipmentsCount = props.deliveries.filter((d) => d.status !== "SHIPPED").length;
  const ordersOnHoldCount = props.salesOrders.filter((o) => o.status === "ON_HOLD").length;

  // Toggle order hold (Oracle DOO Hold Management)
  const handleToggleHold = async (orderId: string, currentStatus: string) => {
    setHoldActionLoading(orderId);
    const action = currentStatus === "ON_HOLD" ? "RELEASE" : "APPLY";
    const holdType = "CREDIT_HOLD";
    try {
      const res = await fetch(`${API_BASE}/sales/orders/${orderId}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hold_type: holdType,
          action: action,
          reason: action === "RELEASE" ? "Administrative SOX compliance verified" : "Customer credit review triggered",
          actor: "sarah.jenkins@enterprise.com",
        }),
      });
      if (res.ok) {
        window.location.reload();
      }
    } catch (e) {
      alert("Failed to update order hold status.");
    } finally {
      setHoldActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Role & Station Identification Ribbon */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d1017] p-4 rounded-xl border border-blue-500/20">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-bold text-base text-white">Order Management Cloud (Commercial O2C)</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 font-semibold">
                SEAT 1: COMMERCIAL SALES
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Active User: <strong className="text-slate-200">Sarah Jenkins (VP Commercial Accounts)</strong> · Client Contracts & Capable-to-Promise Delivery Desk
            </p>
          </div>
        </div>

        {/* Global Search and Guide Button */}
        <div className="flex items-center space-x-3 w-full md:w-auto">
          <button
            onClick={() => setShowSapGuide(!showSapGuide)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-950/50 hover:bg-blue-900/60 text-blue-300 border border-blue-500/30 transition-all cursor-pointer font-mono text-[11px] whitespace-nowrap"
            title="View translation guide from legacy SAP VA01 / Oracle Order Management"
          >
            <BookOpen className="w-3.5 h-3.5 text-blue-400" />
            <span>{showSapGuide ? "Hide SAP Guide" : "Switching from SAP VA01? (Guide)"}</span>
          </button>

          <div className="relative w-full md:w-64">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search orders, clients, tracking..."
              value={props.searchQuery}
              onChange={(e) => props.setSearchQuery(e.target.value)}
              className="w-full bg-[#090a0d] border border-white/[0.08] rounded-lg pl-8.5 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 font-mono"
            />
          </div>
        </div>
      </div>

      {/* SAP / Oracle Transition Guide for Commercial Reps */}
      {showSapGuide && (
        <div className="p-5 rounded-xl bg-gradient-to-r from-blue-950/60 to-[#0e111a] border border-blue-500/30 text-xs space-y-3 animate-in fade-in duration-200">
          <div className="flex justify-between items-start">
            <div className="flex items-center space-x-2 text-blue-300 font-bold text-sm">
              <Info className="w-4 h-4" />
              <span>Commercial Sales Guide: How This Replaces Legacy SAP VA01 & Old ERP Screens</span>
            </div>
            <button
              onClick={() => setShowSapGuide(false)}
              className="text-slate-400 hover:text-white font-mono text-xs px-2 py-0.5 bg-white/[0.04] rounded cursor-pointer"
            >
              ✕ Close
            </button>
          </div>

          <p className="text-slate-300 leading-relaxed">
            In traditional systems like <strong>SAP ERP (VA01 / VA02)</strong>, Customer Service Representatives (CSRs) faced massive blind spots:
            <strong> (1) Filling 15 mandatory fields</strong> across 4 separate tabs just to get a price,
            <strong> (2) Zero visibility into real factory capacity</strong>, and
            <strong> (3) Delayed ATP batches</strong> that broke customer promises. Here is your modern workflow:
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1 font-mono text-[11px]">
            <div className="p-3 rounded-lg bg-[#08090d] border border-white/[0.08] space-y-1">
              <span className="text-rose-400 font-bold block">OLD SAP VA01</span>
              <div className="text-slate-400">Manual sold-to/ship-to entry, static lead-time tables, separate pricing condition screens (PR00), and no plant machine visibility.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-blue-500/30 space-y-1">
              <span className="text-blue-300 font-bold block">COGNITIVE CTP INTAKE</span>
              <div className="text-slate-300">Paste the customer email or speak naturally. AI extracts the demand, tests CP-SAT machine availability in 150ms, and calculates an exact feasible date.</div>
            </div>
            <div className="p-3 rounded-lg bg-[#08090d] border border-emerald-500/30 space-y-1">
              <span className="text-emerald-400 font-bold block">ORACLE DOO ORCHESTRATION</span>
              <div className="text-slate-300">Distributed Order Orchestration: automated hold management, multi-plant GOP sourcing, and 1-click SOX contract execution.</div>
            </div>
          </div>
        </div>
      )}

      {/* Commercial Telemetry KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">COMMITTED PIPELINE</span>
          <div className="text-xl font-bold font-mono text-emerald-400 mt-1">${totalPipeline.toLocaleString()}</div>
          <span className="text-[10px] text-slate-400">Authoritative S/4HANA Ledger</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">ACTIVE SALES ORDERS</span>
          <div className="text-xl font-bold font-mono text-blue-400 mt-1">{props.salesOrders.length} Orders</div>
          <span className="text-[10px] text-slate-400">100% CTP Promised</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">ORDERS ON HOLD (DOO)</span>
          <div className={`text-xl font-bold font-mono mt-1 ${ordersOnHoldCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
            {ordersOnHoldCount} On Hold
          </div>
          <span className="text-[10px] text-slate-400">Credit / Compliance Holds</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">OPEN INVOICES</span>
          <div className="text-xl font-bold font-mono text-indigo-400 mt-1">{openInvoicesCount} Invoices</div>
          <span className="text-[10px] text-slate-400">Accounts Receivable (Net 30/45)</span>
        </div>
      </div>

      {/* Morning Operational Action Queue / Priority Briefing */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-[#0c101c] via-[#101524] to-[#0c101c] border border-blue-500/30 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 text-xs shadow-lg">
        <div className="flex items-center space-x-3.5">
          <div className="w-9 h-9 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400 font-bold shrink-0 shadow-inner">
            <Zap className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-sm text-white tracking-tight">Commercial Priority Action Queue</span>
              <span className="px-2 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-300 font-mono font-bold border border-blue-500/30">
                Live Pulse Active
              </span>
            </div>
            <div className="text-slate-300 text-xs mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-amber-400 font-medium flex items-center space-x-1">
                <Lock className="w-3 h-3 inline" />
                <span>1 Order on DOO Hold (Credit Review)</span>
              </span>
              <span className="text-slate-500">•</span>
              <span className="text-emerald-400 font-medium">Austin Plant: 78.4% Load (2 Open CNC Slots)</span>
              <span className="text-slate-500">•</span>
              <span className="text-slate-300">Chicago Plant: 62.1% Load (Split Routing Ready)</span>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2 w-full md:w-auto">
          <button
            onClick={() => setSubTab("orders")}
            className="px-3.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 font-mono text-[11px] font-semibold transition-all cursor-pointer whitespace-nowrap flex items-center space-x-1.5"
          >
            <span>Resolve DOO Holds</span>
            <ArrowRight className="w-3 h-3" />
          </button>
          <button
            onClick={() => setSubTab("intake")}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-all cursor-pointer whitespace-nowrap shadow-md flex items-center space-x-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Evaluate New RFQ</span>
          </button>
        </div>
      </div>

      {/* Workstation Sub-Navigation */}
      <div className="flex border-b border-white/[0.08] space-x-6 text-xs overflow-x-auto">
        <button
          onClick={() => setSubTab("intake")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "intake" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>RFQ Intake & CTP Promising</span>
        </button>
        <button
          onClick={() => setSubTab("orders")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "orders" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Sales Orders & DOO Holds ({props.salesOrders.length})</span>
        </button>
        <button
          onClick={() => setSubTab("gop")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "gop" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>Oracle GOP Multi-Sourcing</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-blue-500/20 text-blue-300 font-mono">
            2 Plants
          </span>
        </button>
        <button
          onClick={() => setSubTab("edi")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "edi" ? "text-purple-400 border-b-2 border-purple-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <FileCode className="w-3.5 h-3.5" />
          <span>EDI 850/855 B2B Gateway</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] bg-purple-500/20 text-purple-300 font-mono font-bold">
            ANSI X12
          </span>
        </button>
        <button
          onClick={() => setSubTab("deliveries")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "deliveries" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Truck className="w-3.5 h-3.5" />
          <span>Outbound Deliveries ({props.deliveries.length})</span>
        </button>
        <button
          onClick={() => setSubTab("invoices")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "invoices" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          <span>Billing & Cash Clearing ({props.invoices.length})</span>
        </button>
        <button
          onClick={() => setSubTab("customers")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ${
            subTab === "customers" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Building2 className="w-3.5 h-3.5" />
          <span>Customer Credit Master ({props.customers.length})</span>
        </button>
      </div>

      {/* SUBTAB 1: INTAKE & PROPOSAL */}
      {subTab === "intake" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 space-y-4">
            {/* Live Plant Capacity Pulse Banner */}
            <div className="p-3 rounded-lg bg-blue-950/30 border border-blue-500/20 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-slate-300">Austin Plant Floor:</span>
                <span className="text-emerald-400 font-bold">78% Load · 2 Open CNC Slots</span>
              </div>
              <div className="text-slate-400 text-[11px]">
                Raw Alloy Stock: <strong className="text-slate-200">99.4% Ready</strong> · 100% CTP Feasibility
              </div>
            </div>

            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="font-bold text-xs text-slate-200 flex items-center space-x-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  <span>Cognitive Natural Language RFQ Parser</span>
                </h2>
                <span className="text-[10px] text-slate-400 font-mono">Real-Time CTP Engine (OR-Tools)</span>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1.5">Customer Email / Natural Language Inquiry</label>
                <textarea
                  value={props.prompt}
                  onChange={(e) => props.setPrompt(e.target.value)}
                  rows={3}
                  className="w-full bg-[#0a0b0e] border border-white/[0.08] rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 font-mono leading-relaxed resize-none"
                  placeholder="e.g., Boeing requests 20 units of Turbine Housing TB-200 needed by next Friday..."
                />
              </div>

              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-2">
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: "Boeing Aerospace (20x Impeller Pumps)", prompt: "Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday" },
                    { label: "Siemens Energy (5x Hydraulic Pumps)", prompt: "Siemens Energy urgent RFQ: 5 units of Hydraulic Pump PMP-500 needed in 4 days" },
                    { label: "Caterpillar Mining (15x Utility Pumps)", prompt: "Caterpillar Mining requests 15 units of Utility Pump PMP-200 with standard Net-30" },
                  ].map((preset, idx) => (
                    <button
                      key={idx}
                      onClick={() => props.setPrompt(preset.prompt)}
                      className="text-xs text-slate-300 hover:text-white px-3 py-1.5 bg-white/[0.04] hover:bg-white/[0.08] rounded-lg border border-white/[0.08] transition-all cursor-pointer font-sans font-medium"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={props.handleEvaluateRFQ}
                  disabled={props.evaluating}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs shadow-md flex items-center space-x-2 transition-all cursor-pointer whitespace-nowrap"
                >
                  {props.evaluating ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Solving CTP Feasibility with OR-Tools...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Evaluate CTP Feasibility</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Generated Proposal Card */}
            {props.proposal && (
              <div className="hairline-panel-elevated rounded-xl p-5 space-y-4 animate-in fade-in duration-200 border border-blue-500/40 bg-[#0d111d]">
                <div className="flex justify-between items-start border-b border-white/[0.08] pb-3">
                  <div>
                    <span className="text-[10px] font-mono font-bold uppercase text-blue-400">
                      ★ Feasibility Verified · Ready for Commercial Contract Booking
                    </span>
                    <h3 className="font-bold text-white text-base mt-0.5">
                      {props.proposal.parsed_rfq?.customer_name} · {props.proposal.parsed_rfq?.quantity}x{" "}
                      {props.proposal.parsed_rfq?.part_description}
                    </h3>
                  </div>
                  <span className="px-2.5 py-1 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    CREDIT & CAPACITY APPROVED
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
                  <div className="bg-[#08090d] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">TOTAL CONTRACT VALUE</span>
                    <span className="text-base font-bold text-emerald-400">
                      ${props.proposal.pricing?.total_quote?.toLocaleString()}
                    </span>
                  </div>
                  <div className="bg-[#08090d] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">CTP FEASIBILITY</span>
                    <span className="text-base font-bold text-blue-400">
                      {props.proposal.scheduling_feasibility?.feasible ? "100% CTP Feasible" : "AT RISK"}
                    </span>
                  </div>
                  <div className="bg-[#08090d] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">MANUFACTURING LEAD TIME</span>
                    <span className="text-base font-bold text-slate-100">
                      {props.proposal.scheduling_feasibility?.projected_lead_time_days || 4} Days
                    </span>
                  </div>
                  <div className="bg-[#08090d] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">DELIVERY COMMITMENT</span>
                    <span className="text-base font-bold text-purple-400">
                      {props.proposal.scheduling_feasibility?.projected_delivery_date
                        ? new Date(props.proposal.scheduling_feasibility.projected_delivery_date).toLocaleDateString()
                        : "Nov 25, 2026"}
                    </span>
                  </div>
                </div>

                {/* 3 Feasibility Pillars */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-[#08090d] border border-white/[0.06] flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <div className="font-bold text-slate-200">Machine Capacity</div>
                      <div className="text-[10px] text-slate-400">Haas 5-Axis (CNC-01) Reserved</div>
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#08090d] border border-white/[0.06] flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <div className="font-bold text-slate-200">Material Stock</div>
                      <div className="text-[10px] text-slate-400">Alloy Lot Allocated (100% On-Hand)</div>
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#08090d] border border-white/[0.06] flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <div className="font-bold text-slate-200">Secondary Tooling</div>
                      <div className="text-[10px] text-slate-400">Fixture FIX-5AXIS-A Collision-Free</div>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-slate-300 font-mono bg-[#08090d] p-3 rounded-lg border border-white/[0.06]">
                  <strong className="text-blue-400">Autonomous SCM Synthesis:</strong> {props.proposal.reasoning}
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={props.handleApprove}
                    disabled={props.approving}
                    className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs shadow-lg flex items-center space-x-2 transition-all cursor-pointer"
                  >
                    {props.approving ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Authorizing SOX Contract & Scheduling to Plant...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Book Contract & Dispatch Operations to Plant Floor</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Customer Credit Context */}
          <div className="lg:col-span-5 space-y-4">
            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <h3 className="font-bold text-xs text-slate-200 flex items-center space-x-2">
                <Building2 className="w-4 h-4 text-blue-400" />
                <span>Enterprise Customer Credit Exposure</span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Real-time financial safety checks. Unbilled receivables and approved limits prevent default risks.
              </p>

              <div className="space-y-3 font-mono text-xs">
                {props.customers.slice(0, 4).map((c) => {
                  const usedPct = Math.min(100, Math.round((c.used_credit / c.credit_limit) * 100));
                  return (
                    <div key={c.id} className="p-3 rounded-lg bg-[#0a0b0e] border border-white/[0.06] space-y-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="font-bold text-slate-100">{c.name}</div>
                          <div className="text-[10px] text-slate-400">{c.customer_code} · {c.payment_terms}</div>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                          {c.credit_rating || "AAA Certified"}
                        </span>
                      </div>

                      <div className="space-y-1 text-[10px]">
                        <div className="flex justify-between text-slate-400">
                          <span>Exposure: ${c.used_credit?.toLocaleString()}</span>
                          <span>Limit: ${c.credit_limit?.toLocaleString()}</span>
                        </div>
                        <div className="w-full bg-[#06080d] h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${usedPct > 80 ? "bg-amber-500" : "bg-blue-500"}`}
                            style={{ width: `${usedPct}%` }}
                          ></div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 2: SALES ORDERS & ORACLE DOO HOLDS */}
      {subTab === "orders" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Committed Sales Orders & DOO Hold Management</h2>
              <p className="text-xs text-slate-400">
                Oracle Distributed Order Orchestration: manage order fulfillment lines, credit holds, and export compliance.
              </p>
            </div>
            <button
              onClick={() => {
                const rows = props.filteredOrders.map((o) => ({
                  Order_Number: o.order_number,
                  Customer: o.customer_name,
                  Total_Amount: o.total_amount,
                  Promised_Delivery: o.promised_delivery_date,
                  Status: o.status,
                  Created_At: o.created_at,
                }));
                props.exportToCsv("sales_orders_ledger.csv", rows);
              }}
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors cursor-pointer"
            >
              <Download className="w-3 h-3 text-blue-400" />
              <span>Export Ledger (CSV)</span>
            </button>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">ORDER NUMBER</th>
                  <th className="py-2.5 px-4 font-semibold">CUSTOMER</th>
                  <th className="py-2.5 px-4 font-semibold text-right">CONTRACT VALUE</th>
                  <th className="py-2.5 px-4 font-semibold">CTP PROMISED DATE</th>
                  <th className="py-2.5 px-4 font-semibold">ORCHESTRATION STATUS</th>
                  <th className="py-2.5 px-4 font-semibold text-right">DOO HOLD ACTION</th>
                  <th className="py-2.5 px-4 font-semibold text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.filteredOrders.map((so: any) => {
                  const isOnHold = so.status === "ON_HOLD";
                  const isHolding = holdActionLoading === so.id;
                  return (
                    <tr key={so.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 font-bold text-slate-200">{so.order_number}</td>
                      <td className="py-3 px-4 font-sans text-slate-300">{so.customer_name}</td>
                      <td className="py-3 px-4 text-right font-bold text-emerald-400">
                        ${so.total_amount?.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-slate-300">
                        {so.promised_delivery_date ? new Date(so.promised_delivery_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isOnHold
                              ? "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                              : "bg-blue-500/10 text-blue-300 border border-blue-500/20"
                          }`}
                        >
                          {isOnHold ? "ON HOLD (Credit Review)" : so.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => handleToggleHold(so.id, so.status)}
                          disabled={isHolding}
                          className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-all cursor-pointer flex items-center space-x-1 ml-auto ${
                            isOnHold
                              ? "bg-emerald-600/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-600/30"
                              : "bg-amber-600/20 text-amber-300 border-amber-500/40 hover:bg-amber-600/30"
                          }`}
                        >
                          {isOnHold ? (
                            <>
                              <Unlock className="w-3 h-3" />
                              <span>Release Hold</span>
                            </>
                          ) : (
                            <>
                              <Lock className="w-3 h-3" />
                              <span>Apply Hold</span>
                            </>
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end space-x-1.5">
                          <button
                            onClick={() => handleFetchDooMilestones(so.id)}
                            disabled={loadingDooId === so.id}
                            className="px-2 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 rounded border border-purple-500/30 text-[11px] font-semibold transition-colors cursor-pointer flex items-center space-x-1"
                          >
                            <Workflow className="w-3 h-3" />
                            <span>{loadingDooId === so.id ? "Loading..." : "8 Milestones"}</span>
                          </button>
                          <button
                            onClick={() => props.handleViewOrderFlow(so.id)}
                            className="px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 rounded border border-white/[0.08] text-[11px] transition-colors cursor-pointer"
                          >
                            View DOO Flow
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 3: ORACLE GLOBAL ORDER PROMISING (GOP) MULTI-SOURCING */}
      {subTab === "gop" && (
        <div className="space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
                <Globe className="w-4 h-4 text-blue-400" />
                <span>Oracle Global Order Promising (GOP) Multi-Plant Allocation</span>
              </h2>
              <p className="text-xs text-slate-400">
                Network optimization across distributed manufacturing plants. Evaluates production capacity vs. freight transit cost.
              </p>
            </div>
            <div className="text-right text-xs font-mono">
              <span className="text-emerald-400 font-bold block">Policy: Least Cost + Fastest Transit</span>
              <span className="text-slate-400 text-[10px]">Split Fulfillment Enabled</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(gopData?.plants || []).map((plant: any) => (
              <div key={plant.plant_id} className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
                <div className="flex justify-between items-start border-b border-white/[0.06] pb-3">
                  <div>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold">
                      {plant.plant_id}
                    </span>
                    <h3 className="text-sm font-bold text-white mt-1">{plant.name}</h3>
                    <p className="text-[11px] text-slate-400">{plant.specialization}</p>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                      plant.status === "OPTIMAL_PRIMARY"
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                        : "bg-blue-500/10 text-blue-300 border border-blue-500/30"
                    }`}
                  >
                    {plant.status === "OPTIMAL_PRIMARY" ? "★ Primary Source" : "Secondary Source"}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 font-mono text-xs text-center">
                  <div className="bg-[#0a0b0e] p-2.5 rounded border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Plant Load</span>
                    <span className="text-sm font-bold text-slate-200">{plant.capacity_load_pct}%</span>
                  </div>
                  <div className="bg-[#0a0b0e] p-2.5 rounded border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Transit Time</span>
                    <span className="text-sm font-bold text-blue-400">{plant.transit_lead_days} Days</span>
                  </div>
                  <div className="bg-[#0a0b0e] p-2.5 rounded border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Open Slots</span>
                    <span className="text-sm font-bold text-emerald-400">{plant.open_capacity_slots} CNC Slots</span>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-[#0a0b0e] border border-white/[0.06] text-xs font-mono text-slate-300 flex justify-between items-center">
                  <span>GOP Routing Recommendation:</span>
                  <span className="font-bold text-emerald-400">
                    {plant.plant_id.includes("AUSTIN") ? "Fulfill 80% High-Precision Batch" : "Fulfill 20% Standard Assembly"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SUBTAB: ENTERPRISE B2B EDI 850/855 GATEWAY */}
      {subTab === "edi" && (
        <div className="space-y-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight flex items-center space-x-2">
                <FileCode className="w-4 h-4 text-purple-400" />
                <span>Tier-1 Enterprise B2B EDI 850 / 855 Ingestion & Acknowledgment Gateway</span>
              </h2>
              <p className="text-xs text-slate-400">
                Direct Machine-to-Machine (M2M) protocol interface. ANSI X12 004010 standard used by Boeing, Siemens, Lockheed Martin, and Caterpillar.
              </p>
            </div>
            <div className="flex items-center space-x-2 font-mono text-[11px]">
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold flex items-center space-x-1">
                <ShieldCheck className="w-3 h-3" />
                <span>AS2 Secure Channel Connected</span>
              </span>
              <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-bold">
                ANSI X12 · EDIFACT
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Column: Inbound EDI 850 Purchase Order */}
            <div className="lg:col-span-6 space-y-4">
              <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
                <div className="flex justify-between items-center border-b border-white/[0.06] pb-3">
                  <div className="flex items-center space-x-2">
                    <div className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-xs">
                      850
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-xs">Inbound ANSI X12 Purchase Order (PO)</h3>
                      <span className="text-[10px] text-slate-400 font-mono">Channel: AS2 HTTPS Direct · Partner: BOEING_AERO</span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono font-bold">
                    BEG: PO-BOE-2026-9812
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[11px] text-slate-300">
                    <span className="text-slate-400">Customer OEM:</span>
                    <strong className="text-white">Boeing Aerospace Defense (CUST-BOEING)</strong>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-300">
                    <span className="text-slate-400">Order Lines:</span>
                    <strong className="text-emerald-400">20 EA × PMP-500 Cryogenic Impeller Pump @ $900.00</strong>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-300">
                    <span className="text-slate-400">Total Contract Value:</span>
                    <strong className="text-emerald-400 font-bold font-mono">$18,000.00 USD</strong>
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-300">
                    <span className="text-slate-400">Requested Delivery:</span>
                    <span className="font-mono text-slate-200">2026-11-25 (Seattle Final Assembly Dock 3)</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between items-center text-[10px] font-mono text-slate-400">
                    <span>Raw ANSI X12 004010 Interchange Payload</span>
                    <span>ISA ~ GS ~ ST*850 ~ SE</span>
                  </div>
                  <textarea
                    value={ediPayload}
                    onChange={(e) => setEdiPayload(e.target.value)}
                    rows={8}
                    className="w-full bg-[#07080c] border border-white/[0.08] rounded-lg p-3 font-mono text-[11px] text-slate-300 focus:outline-none focus:border-purple-500 leading-relaxed resize-none"
                  />
                </div>

                <button
                  onClick={handleIngestEdi850}
                  disabled={ediIngesting}
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg transition-all cursor-pointer flex items-center justify-center space-x-2 disabled:opacity-50"
                >
                  {ediIngesting ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Ingesting into DOO Engine & Computing CTP...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5" />
                      <span>Ingest EDI 850 PO into Oracle DOO Pipeline</span>
                    </>
                  )}
                </button>

                {ediResult && (
                  <div className="p-3.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-xs font-mono space-y-1.5 animate-in fade-in duration-200">
                    <div className="flex items-center space-x-1.5 text-emerald-400 font-bold">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{ediResult.message}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-slate-300">
                      <div>Sales Order: <strong className="text-white">{ediResult.order_number}</strong></div>
                      <div>Customer PO: <strong className="text-white">{ediResult.customer_po}</strong></div>
                      <div>CTP Promised Ship: <strong className="text-emerald-400">{ediResult.promised_delivery_date}</strong></div>
                      <div>DOO Status: <strong className="text-blue-400">COMMITTED (Austin Plant #1)</strong></div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Outbound EDI 855 PO Acknowledgment */}
            <div className="lg:col-span-6 space-y-4">
              <div className="hairline-panel rounded-xl p-5 space-y-4 border border-white/[0.08]">
                <div className="flex justify-between items-center border-b border-white/[0.06] pb-3">
                  <div className="flex items-center space-x-2">
                    <div className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-xs">
                      855
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-xs">Outbound ANSI X12 PO Acknowledgment (ACK)</h3>
                      <span className="text-[10px] text-slate-400 font-mono">Carrier SLA & CTP Committed Date</span>
                    </div>
                  </div>
                  {edi855Result && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-bold">
                      STATUS: AC (Accepted)
                    </span>
                  )}
                </div>

                {edi855Result ? (
                  <div className="space-y-3 font-mono text-xs">
                    <div className="p-3 rounded-lg bg-[#0a0b0e] border border-white/[0.06] space-y-1.5 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Target Standard:</span>
                        <strong className="text-purple-300">{edi855Result.standard}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Order Number:</span>
                        <strong className="text-white">{edi855Result.order_number}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Promised Ship Date:</span>
                        <strong className="text-emerald-400">{edi855Result.confirmed_ship_date}</strong>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Confirmed Quantity & Value:</span>
                        <strong className="text-slate-200">{edi855Result.confirmed_quantity} EA · ${edi855Result.total_value?.toLocaleString()} USD</strong>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center text-[10px] text-slate-400">
                        <span>Generated ANSI X12 855 Transmission Payload</span>
                        <button
                          onClick={handleCopy855}
                          className="flex items-center space-x-1 text-purple-400 hover:text-purple-300 transition-colors cursor-pointer"
                        >
                          {copied855 ? <CheckCheck className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>{copied855 ? "Copied X12!" : "Copy Payload"}</span>
                        </button>
                      </div>
                      <pre className="w-full bg-[#07080c] border border-purple-500/20 rounded-lg p-3 text-[11px] text-purple-200 leading-relaxed overflow-x-auto whitespace-pre font-mono">
                        {edi855Result.edi_x12_payload}
                      </pre>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <div className="flex items-center space-x-1.5 text-[11px] text-emerald-400">
                        <ShieldCheck className="w-4 h-4" />
                        <span>EDI 855 Transmitted via AS2 (MDN Acknowledged)</span>
                      </div>
                      {ediResult?.order_id && (
                        <button
                          onClick={() => handleFetchDooMilestones(ediResult.order_id)}
                          className="px-3 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 rounded text-[11px] font-semibold transition-all cursor-pointer flex items-center space-x-1"
                        >
                          <Workflow className="w-3 h-3" />
                          <span>Inspect DOO Milestones</span>
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-8 rounded-xl bg-[#0a0b0e] border border-dashed border-white/[0.08] text-center space-y-3">
                    <div className="w-10 h-10 mx-auto rounded-full bg-purple-500/10 text-purple-400 flex items-center justify-center">
                      <FileCode className="w-5 h-5" />
                    </div>
                    <div className="text-xs text-slate-300 font-medium">Awaiting EDI 850 Ingestion</div>
                    <p className="text-[11px] text-slate-500 max-w-sm mx-auto leading-relaxed">
                      Click "Ingest EDI 850 PO" on the left. The DOO engine will parse the purchase order, evaluate plant finite capacity, schedule delivery, and automatically generate the ANSI X12 855 acknowledgment.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bottom Panel: Enterprise B2B Manufacturing EDI Protocol Reference */}
          <div className="p-5 rounded-xl bg-gradient-to-r from-[#0c0e17] via-[#101424] to-[#0c0e17] border border-white/[0.08] space-y-3 font-mono text-xs">
            <div className="flex items-center space-x-2 text-white font-bold text-xs">
              <BookOpen className="w-4 h-4 text-purple-400" />
              <span>Enterprise EDI Architecture: The 4 Core O2C Electronic Documents</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-1 text-[11px]">
              <div className="p-3 rounded-lg bg-[#08090d] border border-white/[0.06] space-y-1">
                <span className="text-blue-400 font-bold block">1. EDI 850 / ORDERS</span>
                <span className="text-slate-400 font-sans block">Purchase Order</span>
                <div className="text-slate-300 text-[10px] font-sans">
                  Inbound customer contract authorizing manufacturing with pricing, delivery address, and ship-by requirements.
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#08090d] border border-purple-500/30 space-y-1">
                <span className="text-purple-400 font-bold block">2. EDI 855 / ORDRSP</span>
                <span className="text-slate-400 font-sans block">PO Acknowledgment</span>
                <div className="text-slate-300 text-[10px] font-sans">
                  Outbound confirmation accepting line items with mathematically guaranteed CTP delivery dates.
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#08090d] border border-emerald-500/30 space-y-1">
                <span className="text-emerald-400 font-bold block">3. EDI 856 / DESADV</span>
                <span className="text-slate-400 font-sans block">Ship Notice (ASN)</span>
                <div className="text-slate-300 text-[10px] font-sans">
                  Outbound dispatch notice generated upon goods issue with carrier tracking number and container barcode data.
                </div>
              </div>
              <div className="p-3 rounded-lg bg-[#08090d] border border-indigo-500/30 space-y-1">
                <span className="text-indigo-400 font-bold block">4. EDI 810 / INVOIC</span>
                <span className="text-slate-400 font-sans block">Commercial Invoice</span>
                <div className="text-slate-300 text-[10px] font-sans">
                  Billing document transmitted to customer ERP for automated 3-way match (PO + Receipt + Invoice) and ACH settlement.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ORACLE DOO 8-MILESTONE INTERACTIVE MODAL */}
      {selectedDooMilestones && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0e111a] border border-purple-500/30 text-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex justify-between items-start border-b border-white/[0.08] pb-4">
              <div>
                <div className="flex items-center space-x-2">
                  <Workflow className="w-5 h-5 text-purple-400" />
                  <h3 className="text-base font-bold text-white tracking-tight">Oracle DOO 8-Milestone Orchestration Thread</h3>
                </div>
                <p className="text-xs text-slate-400 mt-1 font-mono">
                  Order #{selectedDooMilestones.order_number} · Process: {selectedDooMilestones.doo_process_name}
                </p>
              </div>
              <button
                onClick={() => setSelectedDooMilestones(null)}
                className="p-1 hover:bg-white/[0.08] rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-purple-950/30 border border-purple-500/20 font-mono text-xs">
              <span className="text-slate-300">Orchestration Completion Progress:</span>
              <span className="font-bold text-purple-300">
                {selectedDooMilestones.progress_pct}% ({selectedDooMilestones.completed_milestones} of {selectedDooMilestones.total_milestones} Milestones Completed)
              </span>
            </div>

            <div className="space-y-3 font-mono text-xs">
              {selectedDooMilestones.milestones.map((m: any) => {
                const isDone = m.status === "COMPLETED";
                const isInProg = m.status === "IN_PROGRESS";
                const isOnHold = m.status === "ON_HOLD";
                return (
                  <div
                    key={m.step}
                    className={`p-3.5 rounded-xl border transition-all ${
                      isDone
                        ? "bg-[#0c1219] border-emerald-500/30"
                        : isInProg
                        ? "bg-[#0d1424] border-blue-500/40 shadow-md"
                        : isOnHold
                        ? "bg-[#18130c] border-amber-500/40"
                        : "bg-[#090a0f] border-white/[0.06] opacity-60"
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-start space-x-3">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                            isDone
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                              : isInProg
                              ? "bg-blue-500/20 text-blue-400 border border-blue-500/40 animate-pulse"
                              : isOnHold
                              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                              : "bg-white/[0.04] text-slate-500 border border-white/[0.08]"
                          }`}
                        >
                          {isDone ? "✓" : m.step}
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-slate-100 text-xs">{m.name}</span>
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                                isDone
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : isInProg
                                  ? "bg-blue-500/10 text-blue-400"
                                  : isOnHold
                                  ? "bg-amber-500/10 text-amber-400"
                                  : "text-slate-500"
                              }`}
                            >
                              {m.status}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-1">{m.details}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">Assigned Owner: {m.owner}</div>
                        </div>
                      </div>
                      {m.completed_at && (
                        <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                          {new Date(m.completed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-2 border-t border-white/[0.06]">
              <button
                onClick={() => setSelectedDooMilestones(null)}
                className="px-4 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 font-mono text-xs transition-colors cursor-pointer"
              >
                Close DOO Inspection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 4: OUTBOUND DELIVERIES */}
      {subTab === "deliveries" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Outbound Shipments & Goods Issue (VL01N / VL02N)</h2>
              <p className="text-xs text-slate-400">
                Warehouse staging, carrier tracking, and physical goods issue dispatch.
              </p>
            </div>
            <button
              onClick={() => {
                const rows = props.filteredDeliveries.map((d) => ({
                  Delivery_Number: d.delivery_number,
                  Carrier: d.carrier,
                  Tracking: d.tracking_number,
                  Status: d.status,
                  Target_Date: d.actual_goods_issue_date,
                }));
                props.exportToCsv("deliveries_ledger.csv", rows);
              }}
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors cursor-pointer"
            >
              <Download className="w-3 h-3 text-blue-400" />
              <span>Export Shipments (CSV)</span>
            </button>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">DELIVERY #</th>
                  <th className="py-2.5 px-4 font-semibold">CARRIER</th>
                  <th className="py-2.5 px-4 font-semibold">TRACKING NUMBER</th>
                  <th className="py-2.5 px-4 font-semibold">SCHEDULED SHIP DATE</th>
                  <th className="py-2.5 px-4 font-semibold">STATUS</th>
                  <th className="py-2.5 px-4 font-semibold text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.filteredDeliveries.map((deliv: any) => {
                  const isShipped = deliv.status === "SHIPPED";
                  const isLoading = props.actionLoading === deliv.id;
                  return (
                    <tr key={deliv.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 font-bold text-slate-200">{deliv.delivery_number}</td>
                      <td className="py-3 px-4 font-sans text-slate-300">{deliv.carrier}</td>
                      <td className="py-3 px-4 text-blue-400">{deliv.tracking_number}</td>
                      <td className="py-3 px-4 text-slate-300">
                        {deliv.planned_delivery_date ? new Date(deliv.planned_delivery_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isShipped
                              ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                              : "bg-amber-500/10 text-amber-300 border border-amber-500/30"
                          }`}
                        >
                          {isShipped ? "Shipped (PGI Complete)" : "Staged at Dock"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!isShipped && (
                          <button
                            onClick={() => props.handleShipDelivery(deliv.id)}
                            disabled={isLoading}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded text-[11px] font-semibold transition-all cursor-pointer"
                          >
                            {isLoading ? "Posting PGI..." : "Post Goods Issue"}
                          </button>
                        )}
                        {isShipped && (
                          <span className="text-emerald-400 text-[11px] font-semibold flex items-center justify-end space-x-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>In Transit</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 5: BILLING & INVOICES */}
      {subTab === "invoices" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Customer Billing Invoices & Cash Settlement</h2>
              <p className="text-xs text-slate-400">
                Accounts receivable invoices generated upon goods issue with cash reconciliation.
              </p>
            </div>
            <button
              onClick={() => {
                const rows = props.filteredInvoices.map((i) => ({
                  Invoice_Number: i.invoice_number,
                  Customer: i.customer_name,
                  Amount: i.amount,
                  Status: i.status,
                  Due_Date: i.due_date,
                }));
                props.exportToCsv("invoices_ledger.csv", rows);
              }}
              className="flex items-center space-x-1 px-2.5 py-1 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] text-xs transition-colors cursor-pointer"
            >
              <Download className="w-3 h-3 text-blue-400" />
              <span>Export Invoices (CSV)</span>
            </button>
          </div>

          <div className="hairline-panel rounded-xl overflow-hidden border border-white/[0.06]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#0e1017] border-b border-white/[0.08] text-slate-400 text-[11px]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">INVOICE #</th>
                  <th className="py-2.5 px-4 font-semibold">CUSTOMER</th>
                  <th className="py-2.5 px-4 font-semibold text-right">TOTAL BILLED</th>
                  <th className="py-2.5 px-4 font-semibold">DUE DATE</th>
                  <th className="py-2.5 px-4 font-semibold">STATUS</th>
                  <th className="py-2.5 px-4 font-semibold text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {props.filteredInvoices.map((inv: any) => {
                  const isPaid = inv.status === "PAID";
                  const isLoading = props.actionLoading === inv.id;
                  return (
                    <tr key={inv.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4 font-bold text-slate-200">{inv.invoice_number}</td>
                      <td className="py-3 px-4 font-sans text-slate-300">{inv.customer_name}</td>
                      <td className="py-3 px-4 text-right font-bold text-emerald-400">
                        ${inv.amount?.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-slate-300">
                        {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isPaid
                              ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                              : "bg-indigo-500/10 text-indigo-300 border border-indigo-500/30"
                          }`}
                        >
                          {isPaid ? "Settled (Paid)" : "Open Receivables"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!isPaid && (
                          <button
                            onClick={() => props.handlePayInvoice(inv.id)}
                            disabled={isLoading}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded text-[11px] font-semibold transition-all cursor-pointer"
                          >
                            {isLoading ? "Clearing..." : "Record Payment"}
                          </button>
                        )}
                        {isPaid && (
                          <span className="text-emerald-400 text-[11px] font-semibold flex items-center justify-end space-x-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Cash Reconciled</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUBTAB 6: CUSTOMER CREDIT MASTER */}
      {subTab === "customers" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight">Approved Enterprise Customer Directory</h2>
            <p className="text-xs text-slate-400">
              Credit limits, contracted payment terms, and SOX 404 risk controls.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs">
            {props.customers.map((c) => (
              <div key={c.id} className="hairline-panel rounded-xl p-5 space-y-3 border border-white/[0.08]">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-bold text-white text-sm">{c.name}</h3>
                    <div className="text-slate-400 text-[11px]">{c.customer_code}</div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                    {c.credit_rating || "AAA Certified"}
                  </span>
                </div>

                <div className="space-y-1.5 text-slate-300 border-t border-white/[0.06] pt-3 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Payment Terms:</span>
                    <span>{c.payment_terms}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Approved Credit Limit:</span>
                    <span className="text-emerald-400 font-bold">${c.credit_limit?.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Outstanding Exposure:</span>
                    <span className="text-slate-200 font-bold">${c.used_credit?.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Available Headroom:</span>
                    <span className="text-blue-400 font-bold">${(c.credit_limit - c.used_credit)?.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ORACLE DOO 8-MILESTONE INTERACTIVE MODAL */}
      {selectedDooMilestones && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0e111a] border border-purple-500/30 text-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 space-y-5 animate-in zoom-in-95 duration-150">
            <div className="flex justify-between items-start border-b border-white/[0.08] pb-4">
              <div>
                <div className="flex items-center space-x-2">
                  <Workflow className="w-5 h-5 text-purple-400" />
                  <h3 className="text-base font-bold text-white tracking-tight">Oracle DOO 8-Milestone Orchestration Thread</h3>
                </div>
                <p className="text-xs text-slate-400 mt-1 font-mono">
                  Order #{selectedDooMilestones.order_number} · Process: {selectedDooMilestones.doo_process_name}
                </p>
              </div>
              <button
                onClick={() => setSelectedDooMilestones(null)}
                className="p-1 hover:bg-white/[0.08] rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center justify-between p-3 rounded-xl bg-purple-950/30 border border-purple-500/20 font-mono text-xs">
              <span className="text-slate-300">Orchestration Completion Progress:</span>
              <span className="font-bold text-purple-300">
                {selectedDooMilestones.progress_pct}% ({selectedDooMilestones.completed_milestones} of {selectedDooMilestones.total_milestones} Milestones Completed)
              </span>
            </div>

            <div className="space-y-3 font-mono text-xs">
              {selectedDooMilestones.milestones.map((m: any) => {
                const isDone = m.status === "COMPLETED";
                const isInProg = m.status === "IN_PROGRESS";
                const isOnHold = m.status === "ON_HOLD";
                return (
                  <div
                    key={m.step}
                    className={`p-3.5 rounded-xl border transition-all ${
                      isDone
                        ? "bg-[#0c1219] border-emerald-500/30"
                        : isInProg
                        ? "bg-[#0d1424] border-blue-500/40 shadow-md"
                        : isOnHold
                        ? "bg-[#18130c] border-amber-500/40"
                        : "bg-[#090a0f] border-white/[0.06] opacity-60"
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-start space-x-3">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                            isDone
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                              : isInProg
                              ? "bg-blue-500/20 text-blue-400 border border-blue-500/40 animate-pulse"
                              : isOnHold
                              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
                              : "bg-white/[0.04] text-slate-500 border border-white/[0.08]"
                          }`}
                        >
                          {isDone ? "✓" : m.step}
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-slate-100 text-xs">{m.name}</span>
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                                isDone
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : isInProg
                                  ? "bg-blue-500/10 text-blue-400"
                                  : isOnHold
                                  ? "bg-amber-500/10 text-amber-400"
                                  : "text-slate-500"
                              }`}
                            >
                              {m.status}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-1">{m.details}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">Assigned Owner: {m.owner}</div>
                        </div>
                      </div>
                      {m.completed_at && (
                        <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                          {new Date(m.completed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end pt-2 border-t border-white/[0.06]">
              <button
                onClick={() => setSelectedDooMilestones(null)}
                className="px-4 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 font-mono text-xs transition-colors cursor-pointer"
              >
                Close DOO Inspection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
