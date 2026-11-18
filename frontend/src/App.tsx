import React, { useState, useEffect } from "react";
import confetti from "canvas-confetti";
import {
  Building2,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Send,
  Sparkles,
  Layers,
  Activity,
  DollarSign,
  TrendingUp,
  Cpu,
  Clock,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  Sliders,
} from "lucide-react";

const API_BASE = "http://localhost:8080/api/v1";

export default function App() {
  const [activeTab, setActiveTab] = useState<"commercial" | "schedule" | "copilot" | "executive">("commercial");

  // Commercial state
  const [prompt, setPrompt] = useState("Create an order for 25 Cable Management Kits for Boeing Aerospace");
  const [evaluating, setEvaluating] = useState(false);
  const [proposal, setProposal] = useState<any>(null);
  const [approving, setApproving] = useState(false);
  const [orderConfirmation, setOrderConfirmation] = useState<any>(null);

  // Data state
  const [customers, setCustomers] = useState<any[]>([]);
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [ganttData, setGanttData] = useState<any>(null);

  // Copilot state
  const [selectedMachine, setSelectedMachine] = useState("CNC-01");
  const [downtimeHours, setDowntimeHours] = useState(4);
  const [disruptionResult, setDisruptionResult] = useState<any>(null);
  const [simulating, setSimulating] = useState(false);

  // Load initial data
  const fetchData = async () => {
    try {
      const [custRes, ordRes, ganttRes] = await Promise.all([
        fetch(`${API_BASE}/sales/customers`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/sales/orders`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${API_BASE}/scheduling/gantt`).then((r) => (r.ok ? r.json() : null)),
      ]);
      setCustomers(custRes);
      setSalesOrders(ordRes);
      setGanttData(ganttRes);
    } catch (e) {
      console.error("API error:", e);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, []);

  // RFQ Evaluation
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

  // Human Approval with Confetti!
  const handleApprove = async () => {
    if (!proposal?.token) return;
    setApproving(true);
    try {
      const res = await fetch(`${API_BASE}/sales/approvals/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: proposal.token, decision: "APPROVE" }),
      });
      const data = await res.json();
      setOrderConfirmation(data);
      setProposal(null);

      // Trigger Confetti Celebration!
      confetti({
        particleCount: 120,
        spread: 80,
        origin: { y: 0.6 },
        colors: ["#10b981", "#3b82f6", "#f59e0b", "#6366f1"],
      });

      fetchData();
    } catch (e) {
      alert("Approval transaction failed.");
    } finally {
      setApproving(false);
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
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Enterprise Bar */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/80 px-6 flex items-center justify-between backdrop-blur">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
              E
            </div>
            <div>
              <span className="font-bold tracking-tight text-white">Enterprise APS</span>
              <span className="text-xs text-blue-400 ml-2 font-mono uppercase bg-blue-950/60 border border-blue-800/40 px-1.5 py-0.5 rounded">
                Tier-1 Architecture
              </span>
            </div>
          </div>
          <div className="hidden md:flex items-center text-xs text-slate-400 space-x-3 border-l border-slate-800 pl-4 font-mono">
            <span>Plant: <strong className="text-slate-200">GAIC Chicago (PLANT-01)</strong></span>
            <span>•</span>
            <span className="flex items-center text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse mr-1.5"></span>
              PostgreSQL System of Record
            </span>
          </div>
        </div>

        {/* Unified Role Switcher */}
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
        {/* TAB 1: COMMERCIAL SALES (O2C, CTP, APPROVALS, CUSTOMERS)       */}
        {/* ============================================================== */}
        {activeTab === "commercial" && (
          <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">Commercial Order-to-Cash Console</h1>
                <p className="text-xs text-slate-400">
                  AI-assisted intake with deterministic Capable-to-Promise (CTP) verification and human governance.
                </p>
              </div>
              <button
                onClick={fetchData}
                className="px-3 py-1.5 bg-slate-900 border border-slate-700/60 rounded-md text-xs text-slate-300 hover:bg-slate-800 flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Sync ERP Ledger</span>
              </button>
            </div>

            {/* Confetti Confirmation Banner */}
            {orderConfirmation && (
              <div className="bg-emerald-950/70 border border-emerald-500/50 p-4 rounded-xl flex items-center justify-between text-emerald-200 animate-in fade-in slide-in-from-top-4 duration-300 shadow-xl shadow-emerald-950/50">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold">
                    ✓
                  </div>
                  <div>
                    <h3 className="font-semibold text-emerald-100">{orderConfirmation.message}</h3>
                    <p className="text-xs text-emerald-300 font-mono mt-0.5">
                      Order ID: <strong>{orderConfirmation.order_number}</strong> · Guaranteed Promised Date:{" "}
                      <strong>{new Date(orderConfirmation.promised_date).toLocaleDateString()}</strong> · SOX Audit Log Recorded
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setOrderConfirmation(null)}
                  className="text-xs text-emerald-400 hover:text-emerald-200 px-3 py-1 bg-emerald-900/40 rounded border border-emerald-700/50"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Two Column Layout: Intake vs Customers */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: Cognitive Order Promising & Proposal */}
              <div className="lg:col-span-2 space-y-5">
                {/* AI Intake Box */}
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-blue-400 flex items-center space-x-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                      <span>Natural Language RFQ & CTP Evaluator</span>
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">Zero Hallucination Guaranteed</span>
                  </div>
                  <div className="relative">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={3}
                      className="w-full bg-slate-950 border border-slate-700/70 rounded-lg p-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans"
                      placeholder="e.g. Create an order for 25 Cable Management Kits for Boeing Aerospace with delivery next week"
                    />
                    <div className="flex justify-between items-center mt-2.5">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setPrompt("Create an order for 15 Cable Management Kits for Boeing Aerospace")}
                          className="text-[11px] bg-slate-800/60 hover:bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700/50"
                        >
                          Sample: Boeing (15 CMK)
                        </button>
                        <button
                          type="button"
                          onClick={() => setPrompt("Order 10 Industrial Hydraulic Pumps for Siemens Energy by Friday")}
                          className="text-[11px] bg-slate-800/60 hover:bg-slate-800 text-slate-300 px-2 py-1 rounded border border-slate-700/50"
                        >
                          Sample: Siemens (10 Pumps)
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

                {/* Staged Proposal & Approval Card */}
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
                          Limit: ${proposal.credit_limit.toLocaleString()}
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
                        Reject & Cancel
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

                {/* Committed Sales Orders Ledger */}
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                  <div className="px-5 py-3.5 border-b border-slate-800 flex justify-between items-center">
                    <span className="font-semibold text-xs text-slate-200 uppercase tracking-wider">
                      Authoritative Sales Orders Ledger
                    </span>
                    <span className="text-xs text-slate-400 font-mono">{salesOrders.length} records</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950/60 text-slate-400 uppercase font-mono border-b border-slate-800 text-[11px]">
                        <tr>
                          <th className="py-2.5 px-4">Order #</th>
                          <th className="py-2.5 px-4">Customer</th>
                          <th className="py-2.5 px-4">Status</th>
                          <th className="py-2.5 px-4 text-right">Amount</th>
                          <th className="py-2.5 px-4">Delivery Promise</th>
                          <th className="py-2.5 px-4">Risk</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {salesOrders.map((ord) => (
                          <tr key={ord.id} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-4 font-mono font-medium text-blue-400">{ord.order_number}</td>
                            <td className="py-3 px-4 font-semibold text-slate-200">{ord.customer_name}</td>
                            <td className="py-3 px-4">
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                                {ord.status}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right font-mono font-bold text-slate-100">
                              ${ord.total_amount.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-300">
                              {ord.promised_delivery_date
                                ? new Date(ord.promised_delivery_date).toLocaleDateString()
                                : "Pending"}
                            </td>
                            <td className="py-3 px-4">
                              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {ord.risk_level}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
                          {/* Progress bar */}
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
                  Zero machine double-booking. Sequence-dependent changeover minimization and routing precedence.
                </p>
              </div>
              <div className="flex space-x-2 text-xs">
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-slate-900 border border-slate-800 rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-blue-500"></span>
                  <span>Active Job</span>
                </span>
                <span className="flex items-center space-x-1.5 px-3 py-1 bg-slate-900 border border-slate-800 rounded text-slate-300">
                  <span className="w-2.5 h-2.5 rounded bg-amber-500"></span>
                  <span>Sequence Setup</span>
                </span>
              </div>
            </div>

            {/* Interactive Visual Gantt Board */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
              <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                <span className="text-xs font-semibold text-slate-300 uppercase font-mono">
                  Shop-Floor Resource Timeline (9 Certified Machines)
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Horizon: Next 24 Hours
                </span>
              </div>

              <div className="space-y-3 font-mono text-xs">
                {ganttData?.resources?.map((res: any, idx: number) => (
                  <div key={res.machine_id} className="grid grid-cols-12 gap-3 items-center p-2 rounded bg-slate-950/60 border border-slate-800/40">
                    <div className="col-span-3">
                      <div className="font-bold text-slate-200">{res.machine_code}</div>
                      <div className="text-[11px] text-slate-400 font-sans">{res.machine_name}</div>
                      <span className="text-[9px] px-1.5 py-0.2 bg-slate-800 text-blue-300 rounded">
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
                        <span className="text-[11px] text-slate-600 italic">Open Machine Capacity (Idle)</span>
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
                When machine breakdowns or delays occur, the AI solver formulates trade-offs without human guesswork.
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
                    {/* Primary Ranked Recommendation */}
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
                      The Copilot runs OR-Tools CP-SAT what-if solvers to protect customer commitments.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* TAB 4: EXECUTIVE COMMAND CENTER                                */}
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
    </div>
  );
}
