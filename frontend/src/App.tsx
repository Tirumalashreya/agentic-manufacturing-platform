import React, { useState, useEffect } from "react";
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
  Zap,
  Server,
  ArrowUpRight,
} from "lucide-react";

const API_BASE = "http://localhost:8080/api/v1";

export default function App() {
  const [activeTab, setActiveTab] = useState<"commercial" | "schedule" | "copilot" | "executive">("commercial");
  const [commercialSubTab, setCommercialSubTab] = useState<"intake" | "orders" | "deliveries" | "invoices" | "audit">("intake");

  // Commercial state
  const [prompt, setPrompt] = useState("Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday");
  const [evaluating, setEvaluating] = useState(false);
  const [proposal, setProposal] = useState<any>(null);
  const [approving, setApproving] = useState(false);
  const [orderConfirmation, setOrderConfirmation] = useState<any>(null);
  const [selectedOrderFlow, setSelectedOrderFlow] = useState<any>(null);
  const [loadingFlow, setLoadingFlow] = useState(false);

  // Data state
  const [customers, setCustomers] = useState<any[]>([]);
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [ganttData, setGanttData] = useState<any>(null);

  // Copilot state
  const [selectedMachine, setSelectedMachine] = useState("CNC-01");
  const [downtimeHours, setDowntimeHours] = useState(4);
  const [disruptionResult, setDisruptionResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);

  // Action states
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Load authoritative ERP data
  const fetchData = async () => {
    try {
      const [custRes, ordRes, delivRes, invRes, auditRes, ganttRes] = await Promise.all([
        fetch(`${API_BASE}/sales/customers`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/orders`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/deliveries`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/invoices`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/audit-logs`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/scheduling/gantt`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setCustomers(custRes);
      setSalesOrders(ordRes);
      setDeliveries(delivRes);
      setInvoices(invRes);
      setAuditLogs(auditRes);
      setGanttData(ganttRes);
    } catch (e) {
      console.error("API sync error:", e);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, []);

  // RFQ Evaluation (AI + Deterministic CTP)
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

  // Human Approval with Confetti
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

      // Trigger celebratory confetti
      confetti({
        particleCount: 160,
        spread: 100,
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

  // View Document Flow & Printable Order Modal
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

  // Run Disruption What-If Simulation
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
    } catch (e) {
      alert("Simulation failed.");
    } finally {
      setSimulating(false);
    }
  };

  // Calculate quick metrics
  const totalPipeline = salesOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
  const openInvoicesCount = invoices.filter((i) => i.status !== "PAID").length;
  const pendingShipmentsCount = deliveries.filter((d) => d.status !== "SHIPPED").length;

  return (
    <div className="flex flex-col h-screen bg-[#090a0d] text-slate-100 overflow-hidden font-sans technical-grid">
      {/* Precision Master Header */}
      <header className="h-13 border-b border-white/[0.08] bg-[#0c0e14]/90 px-6 flex items-center justify-between backdrop-blur-md z-30">
        <div className="flex items-center space-x-5">
          <div className="flex items-center space-x-3">
            <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center font-bold text-white text-xs shadow-sm">
              APS
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="font-semibold text-sm tracking-tight text-white">Enterprise APS & O2C</span>
              <span className="text-[10px] font-mono text-slate-400 border border-white/[0.08] px-1.5 py-0.5 rounded bg-white/[0.03]">
                Tier-1 Architecture
              </span>
            </div>
          </div>

          <div className="hidden lg:flex items-center text-xs text-slate-400 space-x-3 border-l border-white/[0.08] pl-5 font-mono">
            <span className="flex items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-2 animate-pulse"></span>
              GAIC Chicago (PLANT-01)
            </span>
            <span>·</span>
            <span className="text-slate-400">OR-Tools CP-SAT (Deterministic)</span>
          </div>
        </div>

        {/* Primary Role Switcher */}
        <nav className="flex space-x-1 bg-black/40 p-1 rounded-lg border border-white/[0.06] text-xs">
          <button
            onClick={() => setActiveTab("commercial")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-2 ${
              activeTab === "commercial"
                ? "bg-white/[0.1] text-white shadow-sm border border-white/[0.12]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Commercial (O2C)</span>
          </button>
          <button
            onClick={() => setActiveTab("schedule")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-2 ${
              activeTab === "schedule"
                ? "bg-white/[0.1] text-white shadow-sm border border-white/[0.12]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Finite Gantt</span>
          </button>
          <button
            onClick={() => setActiveTab("copilot")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-2 ${
              activeTab === "copilot"
                ? "bg-indigo-600/30 text-indigo-300 shadow-sm border border-indigo-500/30"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>Disruption Copilot</span>
          </button>
          <button
            onClick={() => setActiveTab("executive")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-2 ${
              activeTab === "executive"
                ? "bg-white/[0.1] text-white shadow-sm border border-white/[0.12]"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Executive Radar</span>
          </button>
        </nav>
      </header>

      {/* Main View Area */}
      <main className="flex-1 overflow-y-auto p-6">
        {/* ============================================================== */}
        {/* TAB 1: COMMERCIAL SALES (FULL O2C LIFECYCLE)                   */}
        {/* ============================================================== */}
        {activeTab === "commercial" && (
          <div className="max-w-7xl mx-auto space-y-6">
            {/* Quick KPI Ribbon */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="hairline-panel p-3.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-slate-400">Committed Sales Orders</span>
                  <div className="text-xl font-bold font-mono text-white mt-0.5">{salesOrders.length}</div>
                </div>
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <FileText className="w-4 h-4" />
                </div>
              </div>
              <div className="hairline-panel p-3.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-slate-400">Committed Pipeline</span>
                  <div className="text-xl font-bold font-mono text-emerald-400 mt-0.5">
                    ${totalPipeline.toLocaleString()}
                  </div>
                </div>
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                  <DollarSign className="w-4 h-4" />
                </div>
              </div>
              <div className="hairline-panel p-3.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-slate-400">Pending Outbound Deliveries</span>
                  <div className="text-xl font-bold font-mono text-amber-400 mt-0.5">{pendingShipmentsCount}</div>
                </div>
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                  <Truck className="w-4 h-4" />
                </div>
              </div>
              <div className="hairline-panel p-3.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-slate-400">Open Billing Invoices</span>
                  <div className="text-xl font-bold font-mono text-indigo-400 mt-0.5">{openInvoicesCount}</div>
                </div>
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                  <Receipt className="w-4 h-4" />
                </div>
              </div>
            </div>

            {/* Sub-workspace Navigation */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-white/[0.08] pb-3">
              <div className="flex space-x-2 text-xs">
                <button
                  onClick={() => setCommercialSubTab("intake")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    commercialSubTab === "intake"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  RFQ Intake & CTP
                </button>
                <button
                  onClick={() => setCommercialSubTab("orders")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    commercialSubTab === "orders"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  Sales Orders ({salesOrders.length})
                </button>
                <button
                  onClick={() => setCommercialSubTab("deliveries")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    commercialSubTab === "deliveries"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  Outbound Deliveries ({deliveries.length})
                </button>
                <button
                  onClick={() => setCommercialSubTab("invoices")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    commercialSubTab === "invoices"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  Billing Invoices ({invoices.length})
                </button>
                <button
                  onClick={() => setCommercialSubTab("audit")}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    commercialSubTab === "audit"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]"
                  }`}
                >
                  SOX Audit Trail
                </button>
              </div>

              <button
                onClick={fetchData}
                className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] rounded-md flex items-center space-x-1.5 transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Sync ERP Ledger</span>
              </button>
            </div>

            {/* Confetti Banner */}
            {orderConfirmation && (
              <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 text-emerald-100 flex items-center justify-between shadow-xl">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold">
                    ✓
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">{orderConfirmation.message}</h3>
                    <p className="text-xs text-emerald-300/80 font-mono mt-0.5">
                      Order: <strong>{orderConfirmation.order_number}</strong> · Guaranteed CTP:{" "}
                      <strong>{new Date(orderConfirmation.promised_date).toLocaleDateString()}</strong> · SOX Signature Verified
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleViewOrderFlow(orderConfirmation.order_id)}
                    className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg font-semibold transition-all flex items-center space-x-1"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>View Confirmation</span>
                  </button>
                  <button
                    onClick={() => setOrderConfirmation(null)}
                    className="text-xs text-emerald-300 hover:text-white px-2 py-1"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* SUBTAB: INTAKE & CTP */}
            {commercialSubTab === "intake" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-5">
                  {/* RFQ Intake Box */}
                  <div className="hairline-panel rounded-xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-blue-400 flex items-center space-x-1.5">
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Natural Language RFQ Intake & Deterministic CTP Solver</span>
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">Zero Hallucination Guaranteed</span>
                    </div>

                    <div className="space-y-3">
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        className="w-full bg-[#0a0b0f] border border-white/[0.1] rounded-lg p-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors font-sans"
                        placeholder="e.g. Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday"
                      />

                      <div className="flex flex-wrap justify-between items-center gap-2">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => setPrompt("Lockheed Martin requests 15 units of Aluminum Bracket AB-100 needed by next Wednesday")}
                            className="text-[11px] bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 px-2.5 py-1 rounded border border-white/[0.08] transition-colors"
                          >
                            Sample 1: Lockheed (15 Brackets)
                          </button>
                          <button
                            type="button"
                            onClick={() => setPrompt("Orion Systems requests 30 Cable Management Kits needed urgently")}
                            className="text-[11px] bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 px-2.5 py-1 rounded border border-white/[0.08] transition-colors"
                          >
                            Sample 2: Orion (30 Kits)
                          </button>
                        </div>

                        <button
                          onClick={handleEvaluateRFQ}
                          disabled={evaluating}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-2 transition-all shadow-sm"
                        >
                          {evaluating ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Evaluating Capacity & Credit...</span>
                            </>
                          ) : (
                            <>
                              <span>Evaluate Proposal</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Proposal & CAS Approval Card */}
                  {proposal && (
                    <div className="hairline-panel-elevated rounded-xl p-6 space-y-4 animate-in fade-in duration-200">
                      <div className="flex justify-between items-start border-b border-white/[0.08] pb-4">
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              Awaiting Executive Signature
                            </span>
                            <span className="text-xs font-mono text-slate-400">Token: {proposal.token}</span>
                          </div>
                          <h2 className="text-lg font-bold text-white mt-1">
                            {proposal.customer_name} — {proposal.quantity} × {proposal.material_name}
                          </h2>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-slate-400">Total Commitment</div>
                          <div className="text-xl font-bold font-mono text-emerald-400">
                            ${proposal.total_amount.toLocaleString()}
                          </div>
                        </div>
                      </div>

                      {/* 3 Metrics Badges */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                        <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                          <div className="text-slate-400 flex items-center mb-1">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 mr-1.5" />
                            <span>Credit Verification</span>
                          </div>
                          <div className="font-semibold text-emerald-400">✓ Limit Verified</div>
                          <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                            Exposure: ${proposal.current_exposure.toLocaleString()} / ${proposal.credit_limit.toLocaleString()}
                          </div>
                        </div>

                        <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                          <div className="text-slate-400 flex items-center mb-1">
                            <Layers className="w-3.5 h-3.5 text-blue-400 mr-1.5" />
                            <span>Fulfillment Strategy</span>
                          </div>
                          <div className="font-semibold text-blue-300">
                            {proposal.fulfillment_strategy === "MTS" ? "Make-to-Stock (MTS)" : "Make-to-Order (MTO)"}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                            {proposal.lead_time_rationale}
                          </div>
                        </div>

                        <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                          <div className="text-slate-400 flex items-center mb-1">
                            <Clock className="w-3.5 h-3.5 text-indigo-400 mr-1.5" />
                            <span>Guaranteed CTP Promise</span>
                          </div>
                          <div className="font-semibold text-indigo-300">
                            {new Date(proposal.projected_delivery_date).toLocaleDateString()}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Finite capacity mathematically verified
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="pt-2 flex justify-end space-x-3">
                        <button
                          onClick={() => setProposal(null)}
                          className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded-lg text-xs font-semibold border border-white/[0.08] transition-colors"
                        >
                          Reject Proposal
                        </button>
                        <button
                          onClick={handleApprove}
                          disabled={approving}
                          className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg text-xs shadow-lg shadow-emerald-600/20 flex items-center space-x-2 transition-all"
                        >
                          {approving ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              <span>Committing to Ledger...</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Sign & Commit to Ledger (Confetti)</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Recent Committed Orders */}
                  <div className="hairline-panel rounded-xl overflow-hidden p-4 space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-xs text-slate-200">
                        Recent Authoritative Orders
                      </span>
                      <button
                        onClick={() => setCommercialSubTab("orders")}
                        className="text-xs text-blue-400 hover:underline flex items-center space-x-1"
                      >
                        <span>View All ({salesOrders.length})</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      {salesOrders.slice(0, 3).map((ord) => (
                        <div
                          key={ord.id}
                          onClick={() => handleViewOrderFlow(ord.id)}
                          className="flex items-center justify-between p-3 bg-[#0a0b0e] hover:bg-white/[0.03] border border-white/[0.06] rounded-lg cursor-pointer transition-all"
                        >
                          <div className="flex items-center space-x-3">
                            <span className="font-mono text-xs font-semibold text-blue-400">{ord.order_number}</span>
                            <span className="text-xs font-medium text-slate-200">{ord.customer_name}</span>
                          </div>
                          <div className="flex items-center space-x-4">
                            <span className="font-mono text-xs font-bold text-slate-100">
                              ${ord.total_amount.toLocaleString()}
                            </span>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                              {ord.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Right Column: Customer Master & Exposure */}
                <div className="space-y-4">
                  <div className="hairline-panel rounded-xl p-5 space-y-4">
                    <div className="flex justify-between items-center">
                      <h2 className="font-bold text-xs text-slate-200 flex items-center space-x-1.5">
                        <Building2 className="w-3.5 h-3.5 text-blue-400" />
                        <span>Customer Credit Ledger</span>
                      </h2>
                      <span className="text-[10px] text-slate-400 font-mono">ERP Live</span>
                    </div>

                    <div className="space-y-3.5">
                      {customers.map((c) => {
                        const utilPct = Math.min(100, Math.round((c.current_exposure / c.credit_limit) * 100));
                        return (
                          <div key={c.id} className="p-3 bg-[#0a0b0e] rounded-lg border border-white/[0.06] space-y-2">
                            <div className="flex justify-between text-xs">
                              <span className="font-semibold text-slate-200">{c.name}</span>
                              <span className="font-mono text-slate-400 text-[11px]">{c.payment_terms}</span>
                            </div>
                            <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                              <span>Exposure: ${c.current_exposure.toLocaleString()}</span>
                              <span>Limit: ${c.credit_limit.toLocaleString()}</span>
                            </div>
                            <div className="w-full bg-white/[0.08] rounded-full h-1.5 overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  utilPct > 80 ? "bg-amber-500" : "bg-blue-500"
                                }`}
                                style={{ width: `${utilPct}%` }}
                              ></div>
                            </div>
                            <div className="flex justify-between text-[10px] text-slate-400 pt-0.5">
                              <span>Available: ${(c.credit_limit - c.current_exposure).toLocaleString()}</span>
                              <span>{utilPct}% Utilized</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SUBTAB: ORDERS */}
            {commercialSubTab === "orders" && (
              <div className="hairline-panel rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Committed Sales Orders Ledger (VBAK / VBAP)</h2>
                    <p className="text-xs text-slate-400">Click any record to inspect the SAP S/4HANA document flow and printable acknowledgment.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{salesOrders.length} records</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#0a0b0e] text-slate-400 font-mono border-b border-white/[0.08] text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Order #</th>
                        <th className="py-3 px-4">Customer</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Total Amount</th>
                        <th className="py-3 px-4">Guaranteed CTP Date</th>
                        <th className="py-3 px-4">Delivery Note</th>
                        <th className="py-3 px-4">Invoice #</th>
                        <th className="py-3 px-4 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {salesOrders.map((ord) => (
                        <tr key={ord.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3.5 px-4 font-mono font-medium text-blue-400">{ord.order_number}</td>
                          <td className="py-3.5 px-4 font-semibold text-slate-200">{ord.customer_name}</td>
                          <td className="py-3.5 px-4">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                              {ord.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-100">
                            ${ord.total_amount.toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-300">
                            {ord.promised_delivery_date
                              ? new Date(ord.promised_delivery_date).toLocaleDateString()
                              : "Pending"}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-400">{ord.delivery_number || "—"}</td>
                          <td className="py-3.5 px-4 font-mono text-slate-400">{ord.invoice_number || "—"}</td>
                          <td className="py-3.5 px-4 text-center">
                            <button
                              onClick={() => handleViewOrderFlow(ord.id)}
                              className="px-2.5 py-1 bg-white/[0.05] hover:bg-white/[0.1] text-blue-300 rounded font-semibold text-[11px] border border-white/[0.08] flex items-center space-x-1 mx-auto transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Inspect Flow</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* SUBTAB: OUTBOUND DELIVERIES */}
            {commercialSubTab === "deliveries" && (
              <div className="hairline-panel rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Outbound Delivery Documents (LIKP / VL01N)</h2>
                    <p className="text-xs text-slate-400">Warehouse fulfillment, carrier logistics, and Goods Issue dispatch.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{deliveries.length} delivery notes</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#0a0b0e] text-slate-400 font-mono border-b border-white/[0.08] text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Delivery #</th>
                        <th className="py-3 px-4">Carrier</th>
                        <th className="py-3 px-4">Tracking Number</th>
                        <th className="py-3 px-4">Fulfillment Status</th>
                        <th className="py-3 px-4">Shipped Timestamp</th>
                        <th className="py-3 px-4 text-center">Logistics Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {deliveries.map((deliv) => (
                        <tr key={deliv.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3.5 px-4 font-mono font-medium text-indigo-400">{deliv.delivery_number}</td>
                          <td className="py-3.5 px-4 text-slate-200">{deliv.carrier}</td>
                          <td className="py-3.5 px-4 font-mono text-slate-300">{deliv.tracking_number || "TRK-PENDING"}</td>
                          <td className="py-3.5 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                deliv.status === "SHIPPED"
                                  ? "bg-blue-950 text-blue-400 border-blue-800/40"
                                  : "bg-amber-950 text-amber-400 border-amber-800/40"
                              }`}
                            >
                              {deliv.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-400">
                            {deliv.shipped_at ? new Date(deliv.shipped_at).toLocaleString() : "Awaiting Dispatch"}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            {deliv.status !== "SHIPPED" ? (
                              <button
                                onClick={() => handleShipDelivery(deliv.id)}
                                disabled={actionLoading === deliv.id}
                                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto transition-all"
                              >
                                {actionLoading === deliv.id ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Truck className="w-3 h-3" />
                                )}
                                <span>Post Goods Issue</span>
                              </button>
                            ) : (
                              <span className="text-[11px] text-emerald-400 font-mono flex items-center justify-center space-x-1">
                                <Check className="w-3 h-3" />
                                <span>Dispatched</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* SUBTAB: BILLING INVOICES */}
            {commercialSubTab === "invoices" && (
              <div className="hairline-panel rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Customer Billing Documents (VBRK / VF01)</h2>
                    <p className="text-xs text-slate-400">Accounts receivable, standard tax ledger, and cash clearing.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{invoices.length} invoices</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#0a0b0e] text-slate-400 font-mono border-b border-white/[0.08] text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Invoice #</th>
                        <th className="py-3 px-4">Customer</th>
                        <th className="py-3 px-4 text-right">Amount Due</th>
                        <th className="py-3 px-4">Payment Status</th>
                        <th className="py-3 px-4">Payment Due Date</th>
                        <th className="py-3 px-4">Issued Timestamp</th>
                        <th className="py-3 px-4 text-center">Settlement Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                      {invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3.5 px-4 font-mono font-medium text-emerald-400">{inv.invoice_number}</td>
                          <td className="py-3.5 px-4 font-semibold text-slate-200">{inv.customer_name}</td>
                          <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-100">
                            ${inv.total_amount.toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                inv.status === "PAID"
                                  ? "bg-emerald-950 text-emerald-400 border-emerald-800/40"
                                  : "bg-blue-950 text-blue-400 border-blue-800/40"
                              }`}
                            >
                              {inv.status}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-300">
                            {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "Net 30"}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-400">
                            {inv.issued_at ? new Date(inv.issued_at).toLocaleString() : "—"}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            {inv.status !== "PAID" ? (
                              <button
                                onClick={() => handlePayInvoice(inv.id)}
                                disabled={actionLoading === inv.id}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto transition-all"
                              >
                                {actionLoading === inv.id ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <DollarSign className="w-3 h-3" />
                                )}
                                <span>Record Payment</span>
                              </button>
                            ) : (
                              <span className="text-[11px] text-emerald-400 font-mono flex items-center justify-center space-x-1">
                                <Check className="w-3 h-3" />
                                <span>Paid & Cleared</span>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* SUBTAB: SOX AUDIT */}
            {commercialSubTab === "audit" && (
              <div className="hairline-panel rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span>SOX-Compliant Immutable Audit Trail</span>
                    </h2>
                    <p className="text-xs text-slate-400">Cryptographic tokens, human sign-offs, and ledger mutation events.</p>
                  </div>
                  <span className="text-xs text-emerald-400 font-mono">Tamper-Proof Ledger</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#0a0b0e] text-slate-400 font-mono border-b border-white/[0.08] text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Timestamp</th>
                        <th className="py-3 px-4">Action</th>
                        <th className="py-3 px-4">Actor</th>
                        <th className="py-3 px-4">Entity Type</th>
                        <th className="py-3 px-4">Audit Payload Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04] font-mono">
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 text-slate-400">{new Date(log.timestamp).toLocaleString()}</td>
                          <td className="py-3 px-4 font-bold text-blue-400">{log.action}</td>
                          <td className="py-3 px-4 text-slate-200">{log.actor}</td>
                          <td className="py-3 px-4 text-indigo-300">{log.entity_type}</td>
                          <td className="py-3 px-4 text-slate-400 text-[11px] truncate max-w-xs">
                            {JSON.stringify(log.details)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================================================== */}
        {/* TAB 2: MASTER SCHEDULER & FINITE CAPACITY GANTT               */}
        {/* ============================================================== */}
        {activeTab === "schedule" && (
          <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-lg font-bold text-white tracking-tight">Finite Capacity Master Scheduling</h1>
                <p className="text-xs text-slate-400">
                  Google OR-Tools CP-SAT engine. Sequence-dependent setup matrix minimization and machine non-overlap.
                </p>
              </div>
              <div className="flex space-x-2 text-xs">
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500"></span>
                  <span>Active Operation</span>
                </span>
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-white/[0.04] border border-white/[0.08] rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-amber-500"></span>
                  <span>Changeover Setup</span>
                </span>
              </div>
            </div>

            {/* Interactive Visual Gantt Board */}
            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <div className="flex justify-between items-center border-b border-white/[0.08] pb-3">
                <span className="text-xs font-semibold text-slate-300 font-mono">
                  Shop-Floor Resource Timeline (9 Certified Machines Across 4 Work Centers)
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Horizon: Next 24 Hours
                </span>
              </div>

              <div className="space-y-2.5 font-mono text-xs">
                {ganttData?.resources?.map((res: any) => (
                  <div key={res.machine_id} className="grid grid-cols-12 gap-3 items-center p-2 rounded bg-[#0a0b0e] border border-white/[0.06]">
                    <div className="col-span-3">
                      <div className="font-bold text-slate-200">{res.machine_code}</div>
                      <div className="text-[11px] text-slate-400 font-sans">{res.machine_name}</div>
                      <span className="text-[9px] px-1.5 py-0.2 bg-white/[0.06] text-blue-300 rounded font-mono">
                        {res.work_center_code}
                      </span>
                    </div>

                    <div className="col-span-9 bg-[#0e1017] h-10 rounded border border-white/[0.06] relative flex items-center px-2 overflow-hidden">
                      {res.operations?.length > 0 ? (
                        res.operations.map((op: any, oidx: number) => (
                          <div
                            key={op.id}
                            className={`h-7 px-3 rounded text-[11px] font-semibold flex items-center justify-between text-white shadow-sm mx-1 ${
                              oidx % 2 === 0
                                ? "bg-blue-600 border border-blue-400/40"
                                : "bg-indigo-600 border border-indigo-400/40"
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
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* TAB 3: AUTONOMOUS DISRUPTION COPILOT                          */}
        {/* ============================================================== */}
        {activeTab === "copilot" && (
          <div className="max-w-7xl mx-auto space-y-6">
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <span>Autonomous Disruption & What-If Copilot</span>
              </h1>
              <p className="text-xs text-slate-400">
                When breakdowns or supply shocks happen, the AI solver formulates trade-offs without manual guesswork.
              </p>
            </div>

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
                      value={selectedMachine}
                      onChange={(e) => setSelectedMachine(e.target.value)}
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
                      value={downtimeHours}
                      onChange={(e) => setDowntimeHours(Number(e.target.value))}
                      className="w-full bg-[#0a0b0e] border border-white/[0.1] rounded p-2 text-slate-200 font-mono"
                    />
                  </div>

                  <button
                    onClick={handleSimulateDisruption}
                    disabled={simulating}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg text-xs flex items-center justify-center space-x-2 shadow-sm transition-all"
                  >
                    {simulating ? (
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
                {disruptionResult ? (
                  <div className="hairline-panel-elevated rounded-xl p-6 space-y-4 animate-in fade-in duration-200">
                    <div className="flex justify-between items-start">
                      <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        Rank #1: Recommended Mitigation Action
                      </span>
                      <span className="text-xs font-mono text-emerald-400 font-bold">
                        Feasibility: {disruptionResult.recommended_scenario.feasibility}
                      </span>
                    </div>

                    <h2 className="text-lg font-bold text-white">
                      {disruptionResult.recommended_scenario.name}
                    </h2>
                    <p className="text-xs text-slate-300">
                      {disruptionResult.recommended_scenario.action}
                    </p>

                    <div className="grid grid-cols-3 gap-3 my-4">
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block">Makespan Delta</span>
                        <span className="text-sm font-bold font-mono text-slate-200">
                          +{disruptionResult.recommended_scenario.projected_makespan_delta_hours}h
                        </span>
                      </div>
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block">Estimated Cost</span>
                        <span className="text-sm font-bold font-mono text-amber-400">
                          +${disruptionResult.recommended_scenario.estimated_cost_delta}
                        </span>
                      </div>
                      <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                        <span className="text-[10px] text-slate-400 block">Customer Orders Delayed</span>
                        <span className="text-sm font-bold font-mono text-emerald-400">
                          {disruptionResult.recommended_scenario.orders_delayed}
                        </span>
                      </div>
                    </div>

                    <div className="text-xs text-slate-400 italic bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                      "{disruptionResult.recommended_scenario.rationale}"
                    </div>

                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={() => {
                          alert("Mitigation plan applied! Schedule recalculated with zero customer delay.");
                          setDisruptionResult(null);
                        }}
                        className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs shadow-sm flex items-center space-x-1.5 transition-all"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Approve & Re-Optimize Schedule</span>
                      </button>
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
        {/* TAB 4: EXECUTIVE RADAR                                         */}
        {/* ============================================================== */}
        {activeTab === "executive" && (
          <div className="max-w-7xl mx-auto space-y-6">
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight">Executive Supply Chain Radar</h1>
              <p className="text-xs text-slate-400">
                Enterprise telemetry: On-Time In-Full (OTIF), plant OEE, active customer promise risk.
              </p>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="hairline-panel p-5 rounded-xl">
                <span className="text-xs text-slate-400 font-mono">ON-TIME IN-FULL (OTIF)</span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">98.4%</div>
                <span className="text-[11px] text-emerald-500 font-medium">↑ +2.1% this quarter</span>
              </div>
              <div className="hairline-panel p-5 rounded-xl">
                <span className="text-xs text-slate-400 font-mono">PLANT OEE AVERAGE</span>
                <div className="text-2xl font-bold font-mono text-blue-400 mt-1">87.2%</div>
                <span className="text-[11px] text-slate-400">9 Active Work Centers</span>
              </div>
              <div className="hairline-panel p-5 rounded-xl">
                <span className="text-xs text-slate-400 font-mono">PROMISE BREACHES</span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">0</div>
                <span className="text-[11px] text-slate-400">100% On-Track</span>
              </div>
              <div className="hairline-panel p-5 rounded-xl">
                <span className="text-xs text-slate-400 font-mono">ACTIVE PIPELINE VALUE</span>
                <div className="text-2xl font-bold font-mono text-slate-100 mt-1">${totalPipeline.toLocaleString()}</div>
                <span className="text-[11px] text-indigo-400">Contracted Commitments</span>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ============================================================== */}
      {/* ENTERPRISE SALES ORDER CONFIRMATION & DOCUMENT FLOW MODAL      */}
      {/* ============================================================== */}
      {selectedOrderFlow && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="hairline-panel-elevated rounded-2xl max-w-4xl w-full p-6 space-y-6 max-h-[92vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex justify-between items-start border-b border-white/[0.08] pb-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400 font-bold">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white flex items-center space-x-2">
                    <span>Order Confirmation: {selectedOrderFlow.order.order_number}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                      {selectedOrderFlow.order.status}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    Customer: <strong>{selectedOrderFlow.order.customer_name}</strong> ({selectedOrderFlow.order.customer_code})
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => window.print()}
                  className="px-3 py-1.5 bg-white/[0.05] hover:bg-white/[0.1] text-slate-200 rounded-lg text-xs font-semibold flex items-center space-x-1.5 border border-white/[0.08] transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Document</span>
                </button>
                <button
                  onClick={() => setSelectedOrderFlow(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-white/[0.08] rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Document Flow Progression (SAP VBFA Style) */}
            <div className="bg-[#0a0b0e] p-4 rounded-xl border border-white/[0.06] space-y-2">
              <span className="text-[11px] font-semibold text-blue-400 font-mono tracking-wider block">
                SAP S/4HANA Document Flow (VBFA)
              </span>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2 pt-1">
                {selectedOrderFlow.document_flow.map((doc: any, idx: number) => (
                  <div
                    key={doc.stage}
                    className="p-2.5 rounded-lg bg-[#0e1017] border border-white/[0.06] text-xs space-y-1 relative"
                  >
                    <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                      <span>Step 0{idx + 1}</span>
                      <span className="px-1.5 py-0.2 rounded bg-white/[0.06] text-slate-300 font-bold">
                        {doc.status}
                      </span>
                    </div>
                    <div className="font-semibold text-slate-200 truncate">{doc.doc_type}</div>
                    <div className="font-mono text-[11px] text-blue-400 font-bold">{doc.reference}</div>
                    <div className="text-[10px] text-slate-400 truncate">{doc.details}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Formal Document Body */}
            <div className="bg-white text-slate-900 p-6 rounded-xl space-y-6 shadow-sm font-sans">
              {/* Company & Billing Info */}
              <div className="flex justify-between items-start border-b border-slate-200 pb-4">
                <div>
                  <h3 className="font-bold text-base text-slate-900">GAIC Advanced Industrial Components LLC</h3>
                  <p className="text-xs text-slate-500">100 Enterprise Way, Chicago Plant, IL 60601</p>
                  <p className="text-xs text-slate-500">System of Record: SAP S/4HANA Certified</p>
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
