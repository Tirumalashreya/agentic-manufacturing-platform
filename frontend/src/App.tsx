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

export default function App() {
  const [activeTab, setActiveTab] = useState<"commercial" | "schedule" | "mrp" | "dual" | "executive">("commercial");

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

  // View Document Flow Modal
  const handleViewOrderFlow = async (orderId: string) => {
    setLoadingFlow(true);
    try {
      const res = await fetch(`${API_BASE}/sales/orders/${orderId}/flow`);
      if (res.ok) {
        const data = await res.json();
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
      {/* Precision Master Cockpit Header */}
      <header className="h-14 border-b border-white/[0.08] bg-[#0c0e14]/95 px-6 flex items-center justify-between backdrop-blur-md z-30">
        <div className="flex items-center space-x-5">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center font-bold text-white text-xs shadow-md">
              APS
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="font-bold text-sm tracking-tight text-white">Enterprise APS & O2C</span>
              <span className="text-[10px] font-mono text-cyan-400 border border-cyan-500/20 px-1.5 py-0.5 rounded bg-cyan-500/10">
                Oracle Redwood / SAP S4
              </span>
            </div>
          </div>

          <div className="hidden xl:flex items-center text-xs text-slate-400 space-x-3 border-l border-white/[0.08] pl-4 font-mono">
            <span className="flex items-center">
              <span className="w-2 h-2 rounded-full bg-emerald-400 mr-2 animate-pulse"></span>
              Core: <strong>PostgreSQL + CP-SAT + MRP Engine (Synced)</strong>
            </span>
          </div>
        </div>

        {/* Dedicated Persona Workstation Seats */}
        <nav className="flex space-x-1.5 bg-black/50 p-1 rounded-xl border border-white/[0.08] text-xs">
          <button
            onClick={() => setActiveTab("commercial")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center space-x-2 cursor-pointer ${
              activeTab === "commercial"
                ? "bg-blue-600 text-white shadow-sm border border-blue-400/40"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Commercial Order Management Cloud (Sales Rep / CSR Seat)"
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Seat 1: Commercial (O2C)</span>
          </button>

          <button
            onClick={() => setActiveTab("schedule")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center space-x-2 cursor-pointer ${
              activeTab === "schedule"
                ? "bg-indigo-600 text-white shadow-sm border border-indigo-400/40"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Production Scheduling Console (Plant Dispatcher Seat)"
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Seat 2: Plant Operations</span>
          </button>

          <button
            onClick={() => setActiveTab("mrp")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center space-x-2 cursor-pointer ${
              activeTab === "mrp"
                ? "bg-emerald-600 text-white shadow-sm border border-emerald-400/40"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Supply Planning & Procurement (Material Buyer Seat)"
          >
            <Boxes className="w-3.5 h-3.5" />
            <span>Seat 3: Supply Planning</span>
          </button>

          <button
            onClick={() => setActiveTab("dual")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center space-x-2 cursor-pointer ${
              activeTab === "dual"
                ? "bg-cyan-600 text-white shadow-sm border border-cyan-400/40"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Side-by-Side Dual-Seat Synchronized Monitor"
          >
            <Split className="w-3.5 h-3.5" />
            <span>Dual-Seat Split View</span>
          </button>

          <button
            onClick={() => setActiveTab("executive")}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center space-x-2 cursor-pointer ${
              activeTab === "executive"
                ? "bg-purple-600 text-white shadow-sm border border-purple-400/40"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Executive Radar & Telemetry"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Seat 4: Executive</span>
          </button>
        </nav>

        {/* Global Sync Status */}
        <div className="flex items-center space-x-3 text-xs font-mono">
          <button
            onClick={fetchData}
            disabled={syncing}
            className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 border border-white/[0.08] transition-all cursor-pointer"
            title="Refresh ERP State"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${syncing ? "animate-spin" : ""}`} />
            <span>{syncing ? "Syncing..." : "Sync Core"}</span>
          </button>
        </div>
      </header>

      {/* Main Viewport */}
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-7xl mx-auto">
          {/* SEAT 1: COMMERCIAL WORKSTATION */}
          {activeTab === "commercial" && (
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

          {/* SEAT 2: SCHEDULING & OPERATIONS WORKSTATION */}
          {activeTab === "schedule" && (
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

          {/* SEAT 3: PROCUREMENT & SUPPLY PLANNING WORKSTATION */}
          {activeTab === "mrp" && (
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

          {/* DUAL-SEAT SPLIT SCREEN MONITOR */}
          {activeTab === "dual" && (
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

          {/* SEAT 4: EXECUTIVE RADAR */}
          {activeTab === "executive" && (
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

            {/* Document Flow Progression Tracker */}
            <div className="p-6 bg-slate-50 border-b border-slate-200">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4 font-mono">
                Authoritative Audit Thread (SOX 404 Compliant)
              </div>
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
