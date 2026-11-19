import React, { useState, useEffect, useMemo } from "react";
import confetti from "canvas-confetti";
import {
  Building2,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Layers,
  Activity,
  DollarSign,
  Cpu,
  Clock,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  Sliders,
  Truck,
  Receipt,
  FileText,
  Printer,
  X,
  ChevronRight,
  Eye,
  Check,
  Search,
  Filter,
  ArrowUpRight,
  Radio,
  BarChart3,
  Download,
  Boxes,
  Split,
  LayoutGrid,
  ExternalLink,
  ChevronDown,
  Globe,
} from "lucide-react";

import CommercialStation from "./components/CommercialStation";
import SchedulingStation from "./components/SchedulingStation";
import SupplyPlanningStation from "./components/SupplyPlanningStation";
import ExecutiveStation from "./components/ExecutiveStation";
import DualStationMonitor from "./components/DualStationMonitor";

const API_BASE = "http://localhost:8080/api/v1";

function exportToCsv(filename: string, rows: Record<string, any>[]) {
  if (!rows || !rows.length) {
    alert("No records to export.");
    return;
  }
  const headers = Object.keys(rows[0]);
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) => {
          let val = row[h] === null || row[h] === undefined ? "" : String(row[h]);
          val = val.replace(/"/g, '""');
          return `"${val}"`;
        })
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Determine active standalone application based on Port, URL search params, or pathname
function getInitialApp(): "commercial" | "schedule" | "mrp" | "dual" | "executive" {
  if (typeof window === "undefined") return "commercial";

  const params = new URLSearchParams(window.location.search);
  const appParam = params.get("app");
  if (appParam === "sales" || appParam === "commercial") return "commercial";
  if (appParam === "aps" || appParam === "schedule" || appParam === "operations") return "schedule";
  if (appParam === "supply" || appParam === "mrp") return "mrp";
  if (appParam === "dual") return "dual";
  if (appParam === "executive") return "executive";

  const path = window.location.pathname.toLowerCase();
  if (path.includes("sales") || path.includes("commercial")) return "commercial";
  if (path.includes("aps") || path.includes("schedule") || path.includes("operations")) return "schedule";
  if (path.includes("supply") || path.includes("mrp")) return "mrp";
  if (path.includes("dual")) return "dual";
  if (path.includes("executive")) return "executive";

  // Dedicated Port Mapping:
  // Port 3001 ➔ Dedicated Commercial Sales Website
  // Port 3002 ➔ Dedicated Plant Operations & APS Console
  // Port 3003 ➔ Dedicated Supply Planning & Procurement
  // Port 3000 ➔ Dual-Station Live Synchronized Monitor
  const port = window.location.port;
  if (port === "3001") return "commercial";
  if (port === "3002") return "schedule";
  if (port === "3003") return "mrp";
  if (port === "3000") return "dual";

  return "commercial";
}

export default function App() {
  const [activeApp, setActiveApp] = useState<"commercial" | "schedule" | "mrp" | "dual" | "executive">(getInitialApp);
  const [showAppSwitcher, setShowAppSwitcher] = useState(false);

  // Synchronize document title based on dedicated app
  useEffect(() => {
    if (activeApp === "commercial") {
      document.title = "Order Management Cloud (Commercial O2C) — GAIC Enterprise";
    } else if (activeApp === "schedule") {
      document.title = "Production Scheduling Console (Plant APS) — Austin Plant #1";
    } else if (activeApp === "mrp") {
      document.title = "Supply Planning & Sourcing Cloud (MRP) — GAIC Global";
    } else if (activeApp === "dual") {
      document.title = "Enterprise SCM Cloud — Dual Workstation Live Monitor";
    } else {
      document.title = "Executive Supply Chain Radar — GAIC Enterprise";
    }
  }, [activeApp]);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");

  // Commercial state
  const [prompt, setPrompt] = useState("Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday");
  const [evaluating, setEvaluating] = useState(false);
  const [proposal, setProposal] = useState<any>(null);
  const [approving, setApproving] = useState(false);
  const [orderConfirmation, setOrderConfirmation] = useState<any>(null);
  const [selectedOrderFlow, setSelectedOrderFlow] = useState<any>(null);
  const [loadingFlow, setLoadingFlow] = useState(false);

  // Authoritative Backend Data State
  const [customers, setCustomers] = useState<any[]>([]);
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [inventoryData, setInventoryData] = useState<any>(null);
  const [ganttData, setGanttData] = useState<any>(null);

  // Scheduling State
  const [ganttWorkCenterFilter, setGanttWorkCenterFilter] = useState<string>("ALL");
  const [inventoryHealthFilter, setInventoryHealthFilter] = useState<string>("ALL");
  const [selectedOperation, setSelectedOperation] = useState<any>(null);
  const [selectedMachine, setSelectedMachine] = useState("CNC-01");
  const [downtimeHours, setDowntimeHours] = useState(4);
  const [disruptionResult, setDisruptionResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);
  const [selectedScenarioIndex, setSelectedScenarioIndex] = useState<number>(0);
  const [applyingMitigation, setApplyingMitigation] = useState(false);
  const [mitigationMessage, setMitigationMessage] = useState<string | null>(null);

  // MRP State
  const [mrpData, setMrpData] = useState<any>(null);
  const [runningMrp, setRunningMrp] = useState(false);
  const [mrpFilterStatus, setMrpFilterStatus] = useState<"ALL" | "SHORTAGES" | "HEALTHY">("ALL");
  const [mrpMessage, setMrpMessage] = useState<string | null>(null);

  // General Action & Sync States
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Switch app helper (updates state and URL query param)
  const handleSwitchApp = (app: "commercial" | "schedule" | "mrp" | "dual" | "executive") => {
    setActiveApp(app);
    setShowAppSwitcher(false);
    const url = new URL(window.location.href);
    const key = app === "commercial" ? "sales" : app === "schedule" ? "aps" : app === "mrp" ? "supply" : app;
    url.searchParams.set("app", key);
    window.history.pushState({}, "", url.toString());
  };

  // Load authoritative ERP data
  const fetchData = async () => {
    setSyncing(true);
    try {
      const [custRes, ordRes, delivRes, invRes, auditRes, ganttRes, invenRes] = await Promise.all([
        fetch(`${API_BASE}/sales/customers`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/orders`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/deliveries`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/invoices`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/audit-logs`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/scheduling/gantt`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API_BASE}/manufacturing/inventory`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setCustomers(custRes);
      setSalesOrders(ordRes);
      setDeliveries(delivRes);
      setInvoices(invRes);
      setAuditLogs(auditRes);
      setGanttData(ganttRes);
      setInventoryData(invenRes);
    } catch (e) {
      console.error("API sync error:", e);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedOrderFlow(null);
        setSelectedOperation(null);
        setShowAppSwitcher(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // RFQ Evaluation (AI Cognitive Parser + Deterministic CTP)
  const handleEvaluateRFQ = async () => {
    setEvaluating(true);
    setOrderConfirmation(null);
    try {
      const res = await fetch(`${API_BASE}/sales/rfq/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setProposal(data);
    } catch (e) {
      alert("Failed to evaluate order prompt.");
    } finally {
      setEvaluating(false);
    }
  };

  // Human Approval with Confetti Celebration
  const handleApprove = async () => {
    if (!proposal?.token) return;
    setApproving(true);
    try {
      const res = await fetch(`${API_BASE}/sales/approvals/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: proposal.token, decision: "APPROVE", approver: "vp.operations@enterprise.com" }),
      });
      const data = await res.json();
      setOrderConfirmation(data);
      setProposal(null);

      confetti({
        particleCount: 180,
        spread: 110,
        origin: { y: 0.6 },
        colors: ["#3b82f6", "#10b981", "#f59e0b", "#6366f1"],
      });

      await fetchData();

      if (data.order_id) {
        handleViewOrderFlow(data.order_id);
      }
    } catch (e) {
      alert("Approval transaction failed.");
    } finally {
      setApproving(false);
    }
  };

  // View Document Flow & Oracle DOO Modal
  const handleViewOrderFlow = async (orderId: string) => {
    setLoadingFlow(true);
    try {
      const [resFlow, resDoo] = await Promise.all([
        fetch(`${API_BASE}/sales/orders/${orderId}/flow`),
        fetch(`${API_BASE}/sales/orders/${orderId}/doo-milestones`),
      ]);
      if (resFlow.ok) {
        const data = await resFlow.json();
        if (resDoo.ok) {
          data.dooMilestones = await resDoo.json();
        }
        setSelectedOrderFlow(data);
      }
    } catch (e) {
      console.error("Error loading order flow:", e);
    } finally {
      setLoadingFlow(false);
    }
  };

  // Post Goods Issue (Ship Delivery)
  const handleShipDelivery = async (deliveryId: string) => {
    setActionLoading(deliveryId);
    try {
      const res = await fetch(`${API_BASE}/sales/deliveries/${deliveryId}/ship`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (e) {
      alert("Failed to post goods issue.");
    } finally {
      setActionLoading(null);
    }
  };

  // Record Customer Payment (Clear Invoice)
  const handlePayInvoice = async (invoiceId: string) => {
    setActionLoading(invoiceId);
    try {
      const res = await fetch(`${API_BASE}/sales/invoices/${invoiceId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        await fetchData();
      }
    } catch (e) {
      alert("Failed to record invoice payment.");
    } finally {
      setActionLoading(null);
    }
  };

  // Disruption Simulation
  const handleSimulateDisruption = async () => {
    setSimulating(true);
    try {
      const res = await fetch(`${API_BASE}/scheduling/disruption/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_code: selectedMachine, downtime_hours: downtimeHours }),
      });
      const data = await res.json();
      setDisruptionResult(data);
      setSelectedScenarioIndex(0);
    } catch (e) {
      alert("Simulation failed.");
    } finally {
      setSimulating(false);
    }
  };

  // Apply Disruption Mitigation Plan
  const handleApplyMitigation = async (scenarioToApply?: any) => {
    if (!disruptionResult) return;
    const allScenarios = [
      ...(disruptionResult.recommended_scenario ? [disruptionResult.recommended_scenario] : []),
      ...(Array.isArray(disruptionResult.alternative_scenarios) ? disruptionResult.alternative_scenarios : []),
    ];
    const target = scenarioToApply || allScenarios[selectedScenarioIndex] || allScenarios[0];
    setApplyingMitigation(true);
    try {
      const isOvertime = target?.scenario_id?.includes("OVERTIME");
      const res = await fetch(`${API_BASE}/scheduling/disruption/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machine_code: selectedMachine,
          downtime_hours: downtimeHours,
          action_type: isOvertime ? "OVERTIME_SHIFT" : "DYNAMIC_REROUTE",
          scenario_name: target?.name || "Mitigation Action",
        }),
      });
      const data = await res.json();
      setMitigationMessage(data.message);
      setDisruptionResult(null);
      await fetchData();
    } catch (e) {
      alert("Failed to apply mitigation.");
    } finally {
      setApplyingMitigation(false);
    }
  };

  // Multi-Level MRP Run (MD01N)
  const handleRunMrp = async () => {
    setRunningMrp(true);
    setMrpMessage(null);
    try {
      const res = await fetch(`${API_BASE}/mrp/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      setMrpData(data);
      setMrpMessage(
        data.shortages_detected_count > 0
          ? `MRP Run Complete (MD01N): Identified ${data.shortages_detected_count} component shortage(s). Auto-generated ${data.generated_purchase_requisitions?.length || 0} Purchase Requisition(s).`
          : "MRP Run Complete (MD01N): All components healthy. Zero material shortages detected across active demand."
      );
      await fetchData();
    } catch (e) {
      alert("Failed to execute MRP run.");
    } finally {
      setRunningMrp(false);
    }
  };

  // Approve Purchase Requisition into Released PO (ME21N)
  const handleApprovePo = async (poId: string) => {
    setActionLoading(poId);
    try {
      const res = await fetch(`${API_BASE}/mrp/purchase-orders/${poId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        if (mrpData) {
          await handleRunMrp();
        } else {
          await fetchData();
        }
      }
    } catch (e) {
      alert("Failed to release purchase order.");
    } finally {
      setActionLoading(null);
    }
  };

  // Post Physical Goods Receipt at Dock (MIGO 101)
  const handleReceivePo = async (poId: string) => {
    setActionLoading(poId);
    try {
      const res = await fetch(`${API_BASE}/mrp/purchase-orders/${poId}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        if (mrpData) {
          await handleRunMrp();
        } else {
          await fetchData();
        }
      }
    } catch (e) {
      alert("Failed to post goods receipt.");
    } finally {
      setActionLoading(null);
    }
  };

  // Filtered Collections
  const filteredOrders = useMemo(() => {
    if (!searchQuery.trim()) return salesOrders;
    const q = searchQuery.toLowerCase();
    return salesOrders.filter(
      (o) =>
        o.order_number?.toLowerCase().includes(q) ||
        o.customer_name?.toLowerCase().includes(q) ||
        o.status?.toLowerCase().includes(q)
    );
  }, [salesOrders, searchQuery]);

  const filteredDeliveries = useMemo(() => {
    if (!searchQuery.trim()) return deliveries;
    const q = searchQuery.toLowerCase();
    return deliveries.filter(
      (d) =>
        d.delivery_number?.toLowerCase().includes(q) ||
        d.carrier?.toLowerCase().includes(q) ||
        d.tracking_number?.toLowerCase().includes(q)
    );
  }, [deliveries, searchQuery]);

  const filteredInvoices = useMemo(() => {
    if (!searchQuery.trim()) return invoices;
    const q = searchQuery.toLowerCase();
    return invoices.filter(
      (i) =>
        i.invoice_number?.toLowerCase().includes(q) ||
        i.customer_name?.toLowerCase().includes(q) ||
        i.status?.toLowerCase().includes(q)
    );
  }, [invoices, searchQuery]);

  const filteredGanttResources = useMemo(() => {
    if (!ganttData?.resources) return [];
    if (ganttWorkCenterFilter === "ALL") return ganttData.resources;
    return ganttData.resources.filter(
      (r: any) => r.work_center_code === ganttWorkCenterFilter
    );
  }, [ganttData, ganttWorkCenterFilter]);

  const filteredInventoryItems = useMemo(() => {
    if (!inventoryData?.items) return [];
    let items = inventoryData.items;
    if (inventoryHealthFilter !== "ALL") {
      items = items.filter((i: any) => i.health === inventoryHealthFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i: any) =>
          i.sku?.toLowerCase().includes(q) ||
          i.name?.toLowerCase().includes(q) ||
          i.type?.toLowerCase().includes(q)
      );
    }
    return items;
  }, [inventoryData, inventoryHealthFilter, searchQuery]);

  const filteredMrpItems = useMemo(() => {
    if (!mrpData?.items) return [];
    let items = mrpData.items;
    if (mrpFilterStatus === "SHORTAGES") {
      items = items.filter((i: any) => i.status === "SHORTAGE_DETECTED");
    } else if (mrpFilterStatus === "HEALTHY") {
      items = items.filter((i: any) => i.status === "HEALTHY");
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i: any) =>
          i.sku?.toLowerCase().includes(q) ||
          i.name?.toLowerCase().includes(q) ||
          i.material_type?.toLowerCase().includes(q)
      );
    }
    return items;
  }, [mrpData, mrpFilterStatus, searchQuery]);

  return (
    <div className="flex flex-col h-screen bg-[#090a0d] text-slate-100 overflow-hidden font-sans technical-grid selection:bg-blue-600/30">
      {/* ============================================================== */}
      {/* DEDICATED INDEPENDENT APPLICATION HEADER                       */}
      {/* ============================================================== */}
      <header className="h-14 border-b border-white/[0.08] bg-[#0c0e14]/95 px-6 flex items-center justify-between backdrop-blur-md z-30">
        <div className="flex items-center space-x-4">
          {/* Dedicated Branding by Application */}
          {activeApp === "commercial" && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow-md">
                <Building2 className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="font-bold text-sm tracking-tight text-white">Order Management Cloud</h1>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-bold">
                    Commercial Portal
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  User: <strong className="text-slate-200 font-sans">Sarah Jenkins</strong> · Inside Sales Desk
                </div>
              </div>
            </div>
          )}

          {activeApp === "schedule" && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-md">
                <Calendar className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="font-bold text-sm tracking-tight text-white">Production Scheduling Console</h1>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-bold">
                    Plant APS Portal
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  User: <strong className="text-slate-200 font-sans">Dave Vance</strong> · Austin Plant #1 Dispatcher
                </div>
              </div>
            </div>
          )}

          {activeApp === "mrp" && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center font-bold text-white shadow-md">
                <Boxes className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="font-bold text-sm tracking-tight text-white">Supply Planning Cloud</h1>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 font-bold">
                    MRP & Procurement Portal
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  User: <strong className="text-slate-200 font-sans">Elena Rostova</strong> · Lead Supply Planner
                </div>
              </div>
            </div>
          )}

          {activeApp === "dual" && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-cyan-600 flex items-center justify-center font-bold text-white shadow-md">
                <Split className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="font-bold text-sm tracking-tight text-white">Enterprise SCM Cloud</h1>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 font-bold">
                    Dual-Station Live Monitor
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Digital Thread: <strong className="text-cyan-300">Sales ➔ Plant Dispatch Sync Active</strong>
                </div>
              </div>
            </div>
          )}

          {activeApp === "executive" && (
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center font-bold text-white shadow-md">
                <Activity className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="font-bold text-sm tracking-tight text-white">Executive Telemetry Radar</h1>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-bold">
                    S&OP Leadership
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Executive VP / Operations Leadership
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Global Synchronization Pulse & Oracle Redwood App Switcher */}
        <div className="flex items-center space-x-3 text-xs font-mono">
          <div className="hidden lg:flex items-center space-x-2 px-3 py-1 bg-white/[0.03] border border-white/[0.06] rounded-lg text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Core: <strong>PostgreSQL :8080 (Single Source of Truth)</strong></span>
          </div>

          <button
            onClick={fetchData}
            disabled={syncing}
            className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 border border-white/[0.08] transition-all cursor-pointer"
            title="Refresh ERP State"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${syncing ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">{syncing ? "Syncing..." : "Sync Core"}</span>
          </button>

          {/* Oracle Redwood Enterprise App Navigator Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowAppSwitcher(!showAppSwitcher)}
              className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-white border border-white/[0.12] transition-all cursor-pointer font-sans font-semibold text-xs shadow-sm"
              title="Switch between independent enterprise websites"
            >
              <LayoutGrid className="w-3.5 h-3.5 text-cyan-400" />
              <span>Switch Application</span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showAppSwitcher ? "rotate-180" : ""}`} />
            </button>

            {showAppSwitcher && (
              <div className="absolute right-0 mt-2 w-80 bg-[#0d1017] border border-white/[0.15] rounded-xl shadow-2xl p-2.5 space-y-1.5 z-50 animate-in fade-in zoom-in-95 duration-150 font-sans">
                <div className="px-3 py-1.5 border-b border-white/[0.08] flex justify-between items-center text-[11px] text-slate-400 font-mono">
                  <span>ENTERPRISE APPLICATION PORTALS</span>
                  <span className="text-cyan-400">Single Cloud Core</span>
                </div>

                {/* App 1: Commercial Sales */}
                <button
                  onClick={() => handleSwitchApp("commercial")}
                  className={`w-full p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                    activeApp === "commercial"
                      ? "bg-blue-600/20 border border-blue-500/40 text-white"
                      : "hover:bg-white/[0.05] text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-md bg-blue-600/30 flex items-center justify-center text-blue-400">
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-white">Order Management Cloud</div>
                      <div className="text-[10px] text-slate-400 font-mono">Port :3001 · Sales Rep / CSR Portal</div>
                    </div>
                  </div>
                  {activeApp === "commercial" && <Check className="w-4 h-4 text-blue-400" />}
                </button>

                {/* App 2: Plant Operations & APS */}
                <button
                  onClick={() => handleSwitchApp("schedule")}
                  className={`w-full p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                    activeApp === "schedule"
                      ? "bg-indigo-600/20 border border-indigo-500/40 text-white"
                      : "hover:bg-white/[0.05] text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-md bg-indigo-600/30 flex items-center justify-center text-indigo-400">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-white">Production Scheduling Console</div>
                      <div className="text-[10px] text-slate-400 font-mono">Port :3002 · Plant Floor Dispatcher</div>
                    </div>
                  </div>
                  {activeApp === "schedule" && <Check className="w-4 h-4 text-indigo-400" />}
                </button>

                {/* App 3: Supply Planning & MRP */}
                <button
                  onClick={() => handleSwitchApp("mrp")}
                  className={`w-full p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                    activeApp === "mrp"
                      ? "bg-emerald-600/20 border border-emerald-500/40 text-white"
                      : "hover:bg-white/[0.05] text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-md bg-emerald-600/30 flex items-center justify-center text-emerald-400">
                      <Boxes className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-white">Supply Planning Cloud (MRP)</div>
                      <div className="text-[10px] text-slate-400 font-mono">Port :3003 · Material Buyer & Sourcing</div>
                    </div>
                  </div>
                  {activeApp === "mrp" && <Check className="w-4 h-4 text-emerald-400" />}
                </button>

                {/* App 4: Dual-Monitor Split View */}
                <button
                  onClick={() => handleSwitchApp("dual")}
                  className={`w-full p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                    activeApp === "dual"
                      ? "bg-cyan-600/20 border border-cyan-500/40 text-white"
                      : "hover:bg-white/[0.05] text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-md bg-cyan-600/30 flex items-center justify-center text-cyan-400">
                      <Split className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-white">Dual-Station Live Monitor</div>
                      <div className="text-[10px] text-slate-400 font-mono">Port :3000 · Side-by-Side Sync View</div>
                    </div>
                  </div>
                  {activeApp === "dual" && <Check className="w-4 h-4 text-cyan-400" />}
                </button>

                {/* App 5: Executive Radar */}
                <button
                  onClick={() => handleSwitchApp("executive")}
                  className={`w-full p-2.5 rounded-lg text-left transition-all flex items-center justify-between cursor-pointer ${
                    activeApp === "executive"
                      ? "bg-purple-600/20 border border-purple-500/40 text-white"
                      : "hover:bg-white/[0.05] text-slate-300 border border-transparent"
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <div className="w-7 h-7 rounded-md bg-purple-600/30 flex items-center justify-center text-purple-400">
                      <Activity className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-white">Executive S&OP Radar</div>
                      <div className="text-[10px] text-slate-400 font-mono">Enterprise Telemetry & Leadership</div>
                    </div>
                  </div>
                  {activeApp === "executive" && <Check className="w-4 h-4 text-purple-400" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ============================================================== */}
      {/* MAIN VIEWPORT: RENDERS ONLY THE ACTIVE INDEPENDENT APPLICATION */}
      {/* ============================================================== */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-7xl mx-auto">
          {/* APPLICATION 1: COMMERCIAL ORDER MANAGEMENT CLOUD */}
          {activeApp === "commercial" && (
            <CommercialStation
              customers={customers}
              salesOrders={salesOrders}
              deliveries={deliveries}
              invoices={invoices}
              prompt={prompt}
              setPrompt={setPrompt}
              evaluating={evaluating}
              proposal={proposal}
              approving={approving}
              orderConfirmation={orderConfirmation}
              handleEvaluateRFQ={handleEvaluateRFQ}
              handleApprove={handleApprove}
              handleShipDelivery={handleShipDelivery}
              handlePayInvoice={handlePayInvoice}
              handleViewOrderFlow={handleViewOrderFlow}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              actionLoading={actionLoading}
              filteredOrders={filteredOrders}
              filteredDeliveries={filteredDeliveries}
              filteredInvoices={filteredInvoices}
              exportToCsv={exportToCsv}
            />
          )}

          {/* APPLICATION 2: PRODUCTION SCHEDULING & APS CONSOLE */}
          {activeApp === "schedule" && (
            <SchedulingStation
              ganttData={ganttData}
              materials={inventoryData?.items || []}
              auditLogs={auditLogs}
              selectedMachine={selectedMachine}
              setSelectedMachine={setSelectedMachine}
              downtimeHours={downtimeHours}
              setDowntimeHours={setDowntimeHours}
              simulating={simulating}
              disruptionResult={disruptionResult}
              selectedScenarioIndex={selectedScenarioIndex}
              setSelectedScenarioIndex={setSelectedScenarioIndex}
              applyingMitigation={applyingMitigation}
              mitigationMessage={mitigationMessage}
              setMitigationMessage={setMitigationMessage}
              handleSimulateDisruption={handleSimulateDisruption}
              handleApplyMitigation={handleApplyMitigation}
              ganttWorkCenterFilter={ganttWorkCenterFilter}
              setGanttWorkCenterFilter={setGanttWorkCenterFilter}
              filteredGanttResources={filteredGanttResources}
              inventoryHealthFilter={inventoryHealthFilter}
              setInventoryHealthFilter={setInventoryHealthFilter}
              filteredMaterials={filteredInventoryItems}
              selectedOperation={selectedOperation}
              setSelectedOperation={setSelectedOperation}
              exportToCsv={exportToCsv}
            />
          )}

          {/* APPLICATION 3: SUPPLY PLANNING & STRATEGIC SOURCING */}
          {activeApp === "mrp" && (
            <SupplyPlanningStation
              mrpData={mrpData}
              runningMrp={runningMrp}
              mrpMessage={mrpMessage}
              setMrpMessage={setMrpMessage}
              handleRunMrp={handleRunMrp}
              mrpFilterStatus={mrpFilterStatus}
              setMrpFilterStatus={setMrpFilterStatus}
              filteredMrpItems={filteredMrpItems}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              handleApprovePo={handleApprovePo}
              handleReceivePo={handleReceivePo}
              actionLoading={actionLoading}
              exportToCsv={exportToCsv}
              salesOrdersCount={salesOrders.length}
            />
          )}

          {/* APPLICATION 4: DUAL-MONITOR CROSS-WORKSTATION SPLIT SCREEN */}
          {activeApp === "dual" && (
            <DualStationMonitor
              customers={customers}
              salesOrders={salesOrders}
              prompt={prompt}
              setPrompt={setPrompt}
              evaluating={evaluating}
              proposal={proposal}
              approving={approving}
              handleEvaluateRFQ={handleEvaluateRFQ}
              handleApprove={handleApprove}
              handleViewOrderFlow={handleViewOrderFlow}
              ganttData={ganttData}
              selectedMachine={selectedMachine}
              setSelectedMachine={setSelectedMachine}
              downtimeHours={downtimeHours}
              setDowntimeHours={setDowntimeHours}
              simulating={simulating}
              disruptionResult={disruptionResult}
              selectedScenarioIndex={selectedScenarioIndex}
              setSelectedScenarioIndex={setSelectedScenarioIndex}
              applyingMitigation={applyingMitigation}
              mitigationMessage={mitigationMessage}
              setMitigationMessage={setMitigationMessage}
              handleSimulateDisruption={handleSimulateDisruption}
              handleApplyMitigation={handleApplyMitigation}
              selectedOperation={selectedOperation}
              setSelectedOperation={setSelectedOperation}
              actionLoading={actionLoading}
            />
          )}

          {/* APPLICATION 5: EXECUTIVE S&OP RADAR */}
          {activeApp === "executive" && (
            <ExecutiveStation
              salesOrders={salesOrders}
              materials={inventoryData?.items || []}
              ganttData={ganttData}
              invoices={invoices}
              exportToCsv={exportToCsv}
            />
          )}
        </div>
      </main>

      {/* ============================================================== */}
      {/* AUTHORITATIVE DOCUMENT FLOW & PRINTABLE ORDER MODAL            */}
      {/* ============================================================== */}
      {selectedOrderFlow && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white text-slate-900 rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200">
            {/* Modal Header Controls */}
            <div className="sticky top-0 bg-white/95 backdrop-blur px-6 py-4 border-b border-slate-200 flex justify-between items-center z-10">
              <div className="flex items-center space-x-2">
                <span className="font-mono text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-bold">
                  SAP VBFA / ORACLE FUSION
                </span>
                <span className="text-xs text-slate-500">Document Flow & Live Production Thread</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Document</span>
                </button>
                <button
                  onClick={() => setSelectedOrderFlow(null)}
                  className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Document Flow Progression Tracker / Oracle DOO 8-Milestones */}
            <div className="p-6 bg-slate-50 border-b border-slate-200">
              <div className="flex justify-between items-center mb-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 font-mono flex items-center space-x-2">
                  <span>Authoritative Audit Thread (SOX 404 & Oracle DOO Compliant)</span>
                  {selectedOrderFlow.dooMilestones && (
                    <span className="px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-800 font-bold">
                      {selectedOrderFlow.dooMilestones.progress_pct}% Completed ({selectedOrderFlow.dooMilestones.completed_milestones}/8 Milestones)
                    </span>
                  )}
                </div>
              </div>

              {selectedOrderFlow.dooMilestones ? (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 pt-1 font-mono">
                  {selectedOrderFlow.dooMilestones.milestones.map((m: any) => {
                    const isDone = m.status === "COMPLETED";
                    const isInProg = m.status === "IN_PROGRESS";
                    const isOnHold = m.status === "ON_HOLD";
                    return (
                      <div
                        key={m.step}
                        className={`p-2.5 rounded-lg border text-center transition-all ${
                          isDone
                            ? "bg-emerald-50 border-emerald-300 text-emerald-900"
                            : isInProg
                            ? "bg-blue-50 border-blue-400 text-blue-900 shadow-sm animate-pulse"
                            : isOnHold
                            ? "bg-amber-50 border-amber-300 text-amber-900"
                            : "bg-slate-100/70 border-slate-200 text-slate-500"
                        }`}
                      >
                        <div
                          className={`w-6 h-6 mx-auto rounded-full flex items-center justify-center font-bold text-[11px] mb-1 ${
                            isDone
                              ? "bg-emerald-600 text-white"
                              : isInProg
                              ? "bg-blue-600 text-white"
                              : isOnHold
                              ? "bg-amber-600 text-white"
                              : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          {isDone ? "✓" : m.step}
                        </div>
                        <div className="font-bold text-[10px] leading-tight line-clamp-2">{m.name}</div>
                        <div className="text-[9px] text-slate-500 mt-1 truncate" title={m.owner}>
                          {m.owner.split("(")[0]}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  {[
                    { label: "1. Quotation / RFQ", status: "COMPLETE", desc: "AI Parsed & CTP Solved" },
                    { label: "2. Sales Order", status: "COMPLETE", desc: selectedOrderFlow.order.order_number },
                    {
                      label: "3. Plant Dispatch",
                      status: selectedOrderFlow.production_run ? "COMPLETE" : "IN_PROGRESS",
                      desc: selectedOrderFlow.production_run?.run_number || "Finite Routing",
                    },
                    {
                      label: "4. Outbound Delivery",
                      status: selectedOrderFlow.delivery ? "COMPLETE" : "PENDING",
                      desc: selectedOrderFlow.delivery?.delivery_number || "Staged at Dock",
                    },
                    {
                      label: "5. Customer Invoice",
                      status: selectedOrderFlow.invoice ? "COMPLETE" : "PENDING",
                      desc: selectedOrderFlow.invoice?.invoice_number || "AR Clearing",
                    },
                  ].map((step, idx) => (
                    <div key={idx} className="flex-1 text-center relative">
                      <div
                        className={`w-8 h-8 mx-auto rounded-full flex items-center justify-center font-bold text-xs mb-1.5 ${
                          step.status === "COMPLETE"
                            ? "bg-emerald-600 text-white shadow-sm"
                            : step.status === "IN_PROGRESS"
                            ? "bg-blue-600 text-white animate-pulse"
                            : "bg-slate-200 text-slate-500"
                        }`}
                      >
                        {step.status === "COMPLETE" ? "✓" : idx + 1}
                      </div>
                      <div className="font-semibold text-xs text-slate-800">{step.label}</div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">{step.desc}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Printable Commercial Order Document */}
            <div className="p-8 space-y-6">
              {/* Document Header */}
              <div className="flex justify-between items-start border-b border-slate-200 pb-6">
                <div>
                  <div className="text-xl font-bold tracking-tight text-slate-900">GAIC MANUFACTURING CORP</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Plant #1 Operations · Industrial Automation & Aerospace Division
                  </div>
                  <div className="text-xs text-slate-500 font-mono">1000 Assembly Way, Chicago, IL 60601</div>
                </div>
                <div className="text-right text-xs">
                  <div className="font-bold text-slate-800">SALES ORDER ACKNOWLEDGMENT</div>
                  <div className="font-mono text-slate-600 mt-1">Doc #: {selectedOrderFlow.order.order_number}</div>
                  <div className="text-slate-500">
                    Date: {new Date(selectedOrderFlow.order.created_at).toLocaleDateString()}
                  </div>
                  <div className="text-emerald-700 font-semibold font-mono mt-0.5">
                    CTP Promised: {new Date(selectedOrderFlow.order.promised_date).toLocaleDateString()}
                  </div>
                </div>
              </div>

              {/* Bill-To and Ship-To */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-slate-700 block mb-1">BILL-TO CUSTOMER:</span>
                  <div className="font-semibold text-slate-900">{selectedOrderFlow.order.customer_name}</div>
                  <div className="text-slate-600">Account: {selectedOrderFlow.order.customer_code}</div>
                  <div className="text-slate-600">Payment Terms: {selectedOrderFlow.order.payment_terms}</div>
                </div>
                <div className="p-3 bg-slate-50 rounded border border-slate-200">
                  <span className="font-bold text-slate-700 block mb-1">SHIP-TO / FULFILLMENT:</span>
                  <div className="font-semibold text-slate-900">GAIC Chicago Plant (PLANT-01)</div>
                  <div className="text-slate-600">Fulfillment: Automated Shop-Floor Dispatch</div>
                  <div className="text-slate-600">Carrier: FedEx Priority Freight</div>
                </div>
              </div>

              {/* Line Items Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border border-slate-200">
                  <thead className="bg-slate-100 text-slate-700 uppercase font-mono text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3">Line</th>
                      <th className="py-2 px-3">Item SKU</th>
                      <th className="py-2 px-3">Description</th>
                      <th className="py-2 px-3 text-right">Quantity</th>
                      <th className="py-2 px-3 text-right">Unit Price</th>
                      <th className="py-2 px-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono">
                    {selectedOrderFlow.order.lines.map((l: any) => (
                      <tr key={l.line_number}>
                        <td className="py-2 px-3 text-slate-500">{l.line_number}</td>
                        <td className="py-2 px-3 font-bold text-slate-900">{l.material_sku}</td>
                        <td className="py-2 px-3 text-slate-700 font-sans">{l.material_name}</td>
                        <td className="py-2 px-3 text-right font-bold text-slate-900">{l.quantity}</td>
                        <td className="py-2 px-3 text-right text-slate-700">${l.unit_price.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right font-bold text-slate-900">${l.total_price.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals & Signature */}
              <div className="flex justify-between items-end border-t border-slate-200 pt-4">
                <div className="space-y-1 text-[11px] text-slate-500">
                  <div className="flex items-center space-x-1.5 text-emerald-700 font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>SOX Digital Signature Verified</span>
                  </div>
                  <div>Approved by: <strong className="text-slate-800">{selectedOrderFlow.order.approval_actor}</strong></div>
                  <div className="font-mono text-[10px]">CAS Token: VALIDATED_ON_CHAIN</div>
                </div>
                <div className="text-right space-y-1 text-xs">
                  <div className="text-slate-600">Subtotal: <span className="font-mono">${selectedOrderFlow.order.total_amount.toFixed(2)}</span></div>
                  <div className="text-slate-600">Tax (8%): <span className="font-mono">${selectedOrderFlow.order.tax_amount.toFixed(2)}</span></div>
                  <div className="text-base font-bold text-slate-900 pt-1 border-t border-slate-200">
                    Grand Total: <span className="font-mono">${selectedOrderFlow.order.grand_total.toFixed(2)} USD</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
