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
  UserCheck,
  PackageCheck,
  Eye,
  Check,
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

  // Load authoritative data
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

      // Trigger Confetti Celebration!
      confetti({
        particleCount: 140,
        spread: 90,
        origin: { y: 0.6 },
        colors: ["#10b981", "#3b82f6", "#f59e0b", "#6366f1"],
      });

      await fetchData();

      // Automatically show order document modal
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

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Enterprise Bar */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/90 px-6 flex items-center justify-between backdrop-blur z-20">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
              E
            </div>
            <div>
              <span className="font-bold tracking-tight text-white">Enterprise APS & O2C</span>
              <span className="text-xs text-blue-400 ml-2 font-mono uppercase bg-blue-950/70 border border-blue-800/40 px-1.5 py-0.5 rounded">
                Tier-1 Architecture
              </span>
            </div>
          </div>
          <div className="hidden lg:flex items-center text-xs text-slate-400 space-x-3 border-l border-slate-800 pl-4 font-mono">
            <span>Plant: <strong className="text-slate-200">GAIC Chicago (PLANT-01)</strong></span>
            <span>•</span>
            <span className="flex items-center text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse mr-1.5"></span>
              PostgreSQL / SQLite Ledger
            </span>
          </div>
        </div>

        {/* Unified Role Switcher (SAP Fiori / Oracle Fusion Style) */}
        <nav className="flex space-x-1 bg-slate-950/80 p-1 rounded-lg border border-slate-800 text-xs">
          <button
            onClick={() => setActiveTab("commercial")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-1.5 ${
              activeTab === "commercial"
                ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Commercial (O2C & CTP)</span>
          </button>
          <button
            onClick={() => setActiveTab("schedule")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-1.5 ${
              activeTab === "schedule"
                ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Master Gantt & Finite Capacity</span>
          </button>
          <button
            onClick={() => setActiveTab("copilot")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-1.5 ${
              activeTab === "copilot"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-300" />
            <span>Disruption Copilot</span>
          </button>
          <button
            onClick={() => setActiveTab("executive")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all flex items-center space-x-1.5 ${
              activeTab === "executive"
                ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Executive Radar</span>
          </button>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-6 bg-gradient-to-b from-slate-950 to-slate-900">
        {/* ============================================================== */}
        {/* TAB 1: COMMERCIAL SALES (FULL O2C LIFECYCLE)                   */}
        {/* ============================================================== */}
        {activeTab === "commercial" && (
          <div className="max-w-7xl mx-auto space-y-6">
            {/* O2C Subnavigation Bar */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setCommercialSubTab("intake")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                    commercialSubTab === "intake"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>RFQ Intake & CTP</span>
                </button>
                <button
                  onClick={() => setCommercialSubTab("orders")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                    commercialSubTab === "orders"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Sales Orders ({salesOrders.length})</span>
                </button>
                <button
                  onClick={() => setCommercialSubTab("deliveries")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                    commercialSubTab === "deliveries"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <Truck className="w-3.5 h-3.5" />
                  <span>Outbound Deliveries ({deliveries.length})</span>
                </button>
                <button
                  onClick={() => setCommercialSubTab("invoices")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                    commercialSubTab === "invoices"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <Receipt className="w-3.5 h-3.5" />
                  <span>Billing Invoices ({invoices.length})</span>
                </button>
                <button
                  onClick={() => setCommercialSubTab("audit")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all ${
                    commercialSubTab === "audit"
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>SOX Audit Trail</span>
                </button>
              </div>

              <button
                onClick={fetchData}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700/60 rounded-md text-xs text-slate-300 flex items-center space-x-1 transition-all"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Sync O2C Ledger</span>
              </button>
            </div>

            {/* Confetti Banner */}
            {orderConfirmation && (
              <div className="bg-emerald-950/70 border border-emerald-500/50 p-4 rounded-xl flex items-center justify-between text-emerald-200 animate-in fade-in slide-in-from-top-4 duration-300 shadow-xl shadow-emerald-950/50">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold">
                    ✓
                  </div>
                  <div>
                    <h3 className="font-semibold text-emerald-100">{orderConfirmation.message}</h3>
                    <p className="text-xs text-emerald-300 font-mono mt-0.5">
                      Order: <strong>{orderConfirmation.order_number}</strong> · Delivery:{" "}
                      <strong>{orderConfirmation.delivery_number}</strong> · Invoice:{" "}
                      <strong>{orderConfirmation.invoice_number}</strong> · Promised:{" "}
                      <strong>{new Date(orderConfirmation.promised_date).toLocaleDateString()}</strong>
                    </p>
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleViewOrderFlow(orderConfirmation.order_id)}
                    className="text-xs bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-1 rounded font-semibold transition-all flex items-center space-x-1"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>View Confirmation</span>
                  </button>
                  <button
                    onClick={() => setOrderConfirmation(null)}
                    className="text-xs text-emerald-400 hover:text-emerald-200 px-3 py-1 bg-emerald-900/40 rounded border border-emerald-700/50"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* SUB-TAB 1: INTAKE & PROPOSAL */}
            {commercialSubTab === "intake" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-5">
                  {/* Cognitive Order Promising Intake */}
                  <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center space-x-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                        <span>Cognitive RFQ Parser & Finite-Capacity CTP Promiser</span>
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">Zero Hallucination Guaranteed</span>
                    </div>
                    <div className="relative">
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        className="w-full bg-slate-950 border border-slate-700/70 rounded-lg p-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans"
                        placeholder="e.g. Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday"
                      />
                      <div className="flex flex-wrap justify-between items-center gap-2 mt-2.5">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setPrompt("Lockheed Martin requests 15 units of Aluminum Bracket AB-100 needed by next Wednesday")}
                            className="text-[11px] bg-slate-800/60 hover:bg-slate-800 text-slate-300 px-2.5 py-1 rounded border border-slate-700/50"
                          >
                            Sample 1: Lockheed (15 Brackets)
                          </button>
                          <button
                            type="button"
                            onClick={() => setPrompt("Orion Systems requests 30 Cable Management Kits needed urgently")}
                            className="text-[11px] bg-slate-800/60 hover:bg-slate-800 text-slate-300 px-2.5 py-1 rounded border border-slate-700/50"
                          >
                            Sample 2: Orion (30 Kits)
                          </button>
                        </div>
                        <button
                          onClick={handleEvaluateRFQ}
                          disabled={evaluating}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center space-x-2 transition-all shadow-md shadow-blue-600/30"
                        >
                          {evaluating ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Evaluating Capacity & Credit...</span>
                            </>
                          ) : (
                            <>
                              <span>Evaluate Order Proposal</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Staged Proposal Card (CAS Human Governance) */}
                  {proposal && (
                    <div className="bg-gradient-to-b from-slate-900 to-slate-950 border-2 border-blue-500/50 rounded-xl p-6 shadow-2xl space-y-4 animate-in fade-in duration-300">
                      <div className="flex justify-between items-start border-b border-slate-800 pb-3">
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                              Awaiting Digital Signature
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

                      {/* Verification Badges */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
                          <div className="flex items-center text-xs text-slate-400 mb-1">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 mr-1.5" />
                            <span>Credit Standing</span>
                          </div>
                          <div className="text-sm font-semibold text-emerald-300">
                            ✓ Pre-Approved
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Exposure: ${proposal.current_exposure.toLocaleString()} / ${proposal.credit_limit.toLocaleString()}
                          </div>
                        </div>

                        <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
                          <div className="flex items-center text-xs text-slate-400 mb-1">
                            <Layers className="w-3.5 h-3.5 text-blue-400 mr-1.5" />
                            <span>Fulfillment Strategy</span>
                          </div>
                          <div className="text-sm font-semibold text-blue-300">
                            {proposal.fulfillment_strategy === "MTS" ? "Make-to-Stock (MTS)" : "Make-to-Order (MTO)"}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {proposal.lead_time_rationale}
                          </div>
                        </div>

                        <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800">
                          <div className="flex items-center text-xs text-slate-400 mb-1">
                            <Clock className="w-3.5 h-3.5 text-indigo-400 mr-1.5" />
                            <span>Guaranteed CTP Promise</span>
                          </div>
                          <div className="text-sm font-semibold text-indigo-300">
                            {new Date(proposal.projected_delivery_date).toLocaleDateString()}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Finite capacity verified
                          </div>
                        </div>
                      </div>

                      {/* Human Sign-Off Action */}
                      <div className="pt-2 flex justify-end space-x-3">
                        <button
                          onClick={() => setProposal(null)}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold"
                        >
                          Reject Proposal
                        </button>
                        <button
                          onClick={handleApprove}
                          disabled={approving}
                          className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg text-xs shadow-lg shadow-emerald-600/30 flex items-center space-x-2 transition-all"
                        >
                          {approving ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              <span>Committing to Enterprise Ledger...</span>
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

                  {/* Quick Recent Orders */}
                  <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg p-4">
                    <div className="flex justify-between items-center mb-3">
                      <span className="font-semibold text-xs text-slate-200 uppercase tracking-wider">
                        Recent Committed Sales Orders
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
                          className="flex items-center justify-between p-3 bg-slate-950/60 hover:bg-slate-800/40 border border-slate-800 rounded-lg cursor-pointer transition-all"
                        >
                          <div className="flex items-center space-x-3">
                            <span className="font-mono text-xs font-bold text-blue-400">{ord.order_number}</span>
                            <span className="text-xs font-semibold text-slate-200">{ord.customer_name}</span>
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

                {/* Right Column: Customer Master & Credit Limits */}
                <div className="space-y-4">
                  <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="font-bold text-xs uppercase tracking-wider text-slate-300 flex items-center space-x-1.5">
                        <Building2 className="w-3.5 h-3.5 text-blue-400" />
                        <span>Customer Credit Master</span>
                      </h2>
                      <span className="text-[10px] text-slate-400 font-mono">ERP Synced</span>
                    </div>
                    <div className="space-y-4">
                      {customers.map((c) => {
                        const utilPct = Math.min(100, Math.round((c.current_exposure / c.credit_limit) * 100));
                        return (
                          <div key={c.id} className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/70 space-y-1.5">
                            <div className="flex justify-between text-xs">
                              <span className="font-semibold text-slate-200">{c.name}</span>
                              <span className="font-mono text-slate-400">{c.payment_terms}</span>
                            </div>
                            <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                              <span>Exposure: ${c.current_exposure.toLocaleString()}</span>
                              <span>Limit: ${c.credit_limit.toLocaleString()}</span>
                            </div>
                            <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
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

            {/* SUB-TAB 2: ALL SALES ORDERS */}
            {commercialSubTab === "orders" && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Committed Sales Orders Ledger (VBAK/VBAP)</h2>
                    <p className="text-xs text-slate-400">Click any order to view the full Document Flow and printable Confirmation.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{salesOrders.length} records</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono border-b border-slate-800 text-[11px]">
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
                    <tbody className="divide-y divide-slate-800/60">
                      {salesOrders.map((ord) => (
                        <tr key={ord.id} className="hover:bg-slate-800/40 transition-colors">
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
                          <td className="py-3.5 px-4 font-mono text-slate-400">
                            {ord.delivery_number || "—"}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-slate-400">
                            {ord.invoice_number || "—"}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <button
                              onClick={() => handleViewOrderFlow(ord.id)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-blue-300 rounded font-semibold text-[11px] border border-slate-700 flex items-center space-x-1 mx-auto"
                            >
                              <Eye className="w-3 h-3" />
                              <span>View Flow</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* SUB-TAB 3: OUTBOUND DELIVERIES (GOODS ISSUE) */}
            {commercialSubTab === "deliveries" && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Outbound Delivery Documents (LIKP / VL01N)</h2>
                    <p className="text-xs text-slate-400">Warehouse fulfillment, carrier logistics, and Goods Issue dispatch.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{deliveries.length} delivery notes</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono border-b border-slate-800 text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Delivery #</th>
                        <th className="py-3 px-4">Carrier</th>
                        <th className="py-3 px-4">Tracking Number</th>
                        <th className="py-3 px-4">Fulfillment Status</th>
                        <th className="py-3 px-4">Shipped Timestamp</th>
                        <th className="py-3 px-4 text-center">Logistics Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {deliveries.map((deliv) => (
                        <tr key={deliv.id} className="hover:bg-slate-800/40 transition-colors">
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
                                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto shadow-sm transition-all"
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

            {/* SUB-TAB 4: BILLING INVOICES */}
            {commercialSubTab === "invoices" && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100">Customer Billing Documents (VBRK / VF01)</h2>
                    <p className="text-xs text-slate-400">Accounts receivable, standard tax ledger, and cash clearing.</p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{invoices.length} invoices</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono border-b border-slate-800 text-[11px]">
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
                    <tbody className="divide-y divide-slate-800/60">
                      {invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-slate-800/40 transition-colors">
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
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto shadow-sm transition-all"
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

            {/* SUB-TAB 5: SOX AUDIT TRAIL */}
            {commercialSubTab === "audit" && (
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center">
                  <div>
                    <h2 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span>SOX-Compliant Immutable Audit Trail</span>
                    </h2>
                    <p className="text-xs text-slate-400">Cryptographic tokens, human sign-offs, and ledger mutation events.</p>
                  </div>
                  <span className="text-xs text-emerald-400 font-mono">Tamper-Proof Guarantee</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono border-b border-slate-800 text-[11px]">
                      <tr>
                        <th className="py-3 px-4">Timestamp</th>
                        <th className="py-3 px-4">Action</th>
                        <th className="py-3 px-4">Actor</th>
                        <th className="py-3 px-4">Entity Type</th>
                        <th className="py-3 px-4">Audit Payload Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
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
                <h1 className="text-xl font-bold text-white tracking-tight">Finite Capacity Master Scheduling</h1>
                <p className="text-xs text-slate-400">
                  Mathematical OR-Tools CP-SAT scheduler. Zero double-booking, sequence setup minimization.
                </p>
              </div>
              <div className="flex space-x-2 text-xs">
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-slate-900 border border-slate-800 rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500"></span>
                  <span>Active Operation</span>
                </span>
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-slate-900 border border-slate-800 rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-amber-500"></span>
                  <span>Changeover Setup</span>
                </span>
              </div>
            </div>

            {/* Interactive Visual Gantt Board */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <span className="text-xs font-semibold text-slate-300 uppercase font-mono">
                  Shop-Floor Resource Timeline (9 Certified Machines Across 4 Work Centers)
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Horizon: Next 24 Hours
                </span>
              </div>

              <div className="space-y-3 font-mono text-xs">
                {ganttData?.resources?.map((res: any) => (
                  <div key={res.machine_id} className="grid grid-cols-12 gap-3 items-center p-2 rounded bg-slate-950/60 border border-slate-800/40">
                    <div className="col-span-3">
                      <div className="font-bold text-slate-200">{res.machine_code}</div>
                      <div className="text-[11px] text-slate-400 font-sans">{res.machine_name}</div>
                      <span className="text-[9px] px-1.5 py-0.2 bg-slate-800 text-blue-300 rounded font-mono">
                        {res.work_center_code}
                      </span>
                    </div>

                    {/* Timeline visualization track */}
                    <div className="col-span-9 bg-slate-900/90 h-10 rounded border border-slate-800 relative flex items-center px-2 overflow-hidden">
                      {res.operations?.length > 0 ? (
                        res.operations.map((op: any, oidx: number) => (
                          <div
                            key={op.id}
                            className={`h-7 px-3 rounded text-[11px] font-semibold flex items-center justify-between text-white shadow-md mx-1 ${
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
              <h1 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <span>Autonomous Disruption & What-If Copilot</span>
              </h1>
              <p className="text-xs text-slate-400">
                When breakdowns or supply shocks happen, the AI solver formulates trade-offs without manual guesswork.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Incident Injection Control */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 space-y-4">
                <h3 className="font-bold text-xs uppercase text-slate-300 tracking-wider flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span>Simulate Shop-Floor Incident</span>
                </h3>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-slate-400 block mb-1">Target Machine Failure</label>
                    <select
                      value={selectedMachine}
                      onChange={(e) => setSelectedMachine(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-slate-200"
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
                      className="w-full bg-slate-950 border border-slate-700 rounded p-2 text-slate-200 font-mono"
                    />
                  </div>

                  <button
                    onClick={handleSimulateDisruption}
                    disabled={simulating}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg text-xs flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/30 transition-all"
                  >
                    {simulating ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Solving Multi-Scenario What-If...</span>
                      </>
                    ) : (
                      <>
                        <Cpu className="w-3.5 h-3.5" />
                        <span>Run Autonomous What-If Solver</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Simulation Result & Scenarios */}
              <div className="lg:col-span-2 space-y-4">
                {disruptionResult ? (
                  <div className="space-y-4 animate-in fade-in duration-300">
                    <div className="bg-gradient-to-b from-indigo-950/80 to-slate-900 border-2 border-indigo-500/60 rounded-xl p-6 shadow-2xl">
                      <div className="flex justify-between items-start mb-3">
                        <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                          Rank #1: Recommended Mitigation Action
                        </span>
                        <span className="text-xs font-mono text-emerald-400 font-bold">
                          Feasibility: {disruptionResult.recommended_scenario.feasibility}
                        </span>
                      </div>
                      <h2 className="text-lg font-bold text-white">
                        {disruptionResult.recommended_scenario.name}
                      </h2>
                      <p className="text-xs text-slate-300 mt-1">
                        {disruptionResult.recommended_scenario.action}
                      </p>

                      <div className="grid grid-cols-3 gap-3 my-4">
                        <div className="bg-slate-950/60 p-2.5 rounded border border-slate-800">
                          <span className="text-[10px] text-slate-400 block">Makespan Delta</span>
                          <span className="text-sm font-bold font-mono text-slate-200">
                            +{disruptionResult.recommended_scenario.projected_makespan_delta_hours}h
                          </span>
                        </div>
                        <div className="bg-slate-950/60 p-2.5 rounded border border-slate-800">
                          <span className="text-[10px] text-slate-400 block">Estimated Cost</span>
                          <span className="text-sm font-bold font-mono text-amber-400">
                            +${disruptionResult.recommended_scenario.estimated_cost_delta}
                          </span>
                        </div>
                        <div className="bg-slate-950/60 p-2.5 rounded border border-slate-800">
                          <span className="text-[10px] text-slate-400 block">Customer Orders Delayed</span>
                          <span className="text-sm font-bold font-mono text-emerald-400">
                            {disruptionResult.recommended_scenario.orders_delayed}
                          </span>
                        </div>
                      </div>

                      <div className="text-xs text-slate-400 italic bg-slate-950/40 p-2.5 rounded border border-slate-800/60">
                        "{disruptionResult.recommended_scenario.rationale}"
                      </div>

                      <div className="mt-4 flex justify-end">
                        <button
                          onClick={() => {
                            alert("Mitigation plan applied! Schedule recalculated with zero customer delay.");
                            setDisruptionResult(null);
                          }}
                          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs shadow-lg shadow-emerald-600/30 flex items-center space-x-1.5"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Approve & Re-Optimize Schedule</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-12 text-center text-slate-500 flex flex-col items-center justify-center h-full">
                    <Sliders className="w-10 h-10 mb-2 opacity-40" />
                    <p className="text-sm font-medium">Select a machine and trigger an incident simulation.</p>
                    <p className="text-xs text-slate-600 max-w-sm mt-1">
                      The Copilot runs multi-objective What-If solvers to protect customer commitments.
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
              <h1 className="text-xl font-bold text-white tracking-tight">Executive Supply Chain Radar</h1>
              <p className="text-xs text-slate-400">
                Enterprise telemetry: On-Time In-Full (OTIF), plant OEE, active customer promise risk.
              </p>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg">
                <span className="text-xs text-slate-400 font-mono">ON-TIME IN-FULL (OTIF)</span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">98.4%</div>
                <span className="text-[11px] text-emerald-500 font-medium">↑ +2.1% this quarter</span>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg">
                <span className="text-xs text-slate-400 font-mono">PLANT OEE AVERAGE</span>
                <div className="text-2xl font-bold font-mono text-blue-400 mt-1">87.2%</div>
                <span className="text-[11px] text-slate-400">9 Active Work Centers</span>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg">
                <span className="text-xs text-slate-400 font-mono">PROMISE BREACHES</span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">0</div>
                <span className="text-[11px] text-slate-400">100% On-Track</span>
              </div>
              <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg">
                <span className="text-xs text-slate-400 font-mono">ACTIVE PIPELINE VALUE</span>
                <div className="text-2xl font-bold font-mono text-slate-100 mt-1">$3,585,000</div>
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
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-4xl w-full p-6 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex justify-between items-start border-b border-slate-800 pb-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400 font-bold">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                    <span>Order Confirmation: {selectedOrderFlow.order.order_number}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                      {selectedOrderFlow.order.status}
                    </span>
                  </h2>
                  <p className="text-xs text-slate-400">
                    Authoritative Document · Customer: <strong>{selectedOrderFlow.order.customer_name}</strong> ({selectedOrderFlow.order.customer_code})
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => window.print()}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all border border-slate-700"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Document</span>
                </button>
                <button
                  onClick={() => setSelectedOrderFlow(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-all"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Document Flow Progression (SAP VBFA Style) */}
            <div className="bg-slate-950/70 p-4 rounded-xl border border-slate-800/80 space-y-2">
              <span className="text-[11px] font-semibold uppercase text-blue-400 font-mono tracking-wider block">
                SAP S/4HANA Document Flow (VBFA)
              </span>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2 pt-1">
                {selectedOrderFlow.document_flow.map((doc: any, idx: number) => (
                  <div
                    key={doc.stage}
                    className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-1 relative"
                  >
                    <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono">
                      <span>Step 0{idx + 1}</span>
                      <span className="px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 font-bold">
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
            <div className="bg-white text-slate-900 p-6 rounded-xl space-y-6 shadow-inner font-sans">
              {/* Company & Billing Info */}
              <div className="flex justify-between items-start border-b border-slate-200 pb-4">
                <div>
                  <h3 className="font-bold text-lg text-slate-900">GAIC Advanced Industrial Components LLC</h3>
                  <p className="text-xs text-slate-500">100 Enterprise Way, Chicago Plant, IL 60601</p>
                  <p className="text-xs text-slate-500">System of Record: SAP / Tier-1 Certified SCM</p>
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
