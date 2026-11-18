// frontend/src/components/CommercialStation.tsx
import React, { useState } from "react";
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

export default function CommercialStation(props: CommercialStationProps) {
  const [subTab, setSubTab] = useState<"intake" | "orders" | "deliveries" | "invoices" | "customers">("intake");

  const totalPipeline = props.salesOrders.reduce((sum, o) => sum + (o.total_amount || 0), 0);
  const openInvoicesCount = props.invoices.filter((i) => i.status !== "PAID").length;
  const pendingShipmentsCount = props.deliveries.filter((d) => d.status !== "SHIPPED").length;

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

        {/* Global Search within Commercial */}
        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search orders, clients, tracking..."
            value={props.searchQuery}
            onChange={(e) => props.setSearchQuery(e.target.value)}
            className="w-full bg-[#090a0d] border border-white/[0.08] rounded-lg pl-8.5 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50"
          />
        </div>
      </div>

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
          <span className="text-[11px] text-slate-400 font-mono block">PENDING SHIPMENTS</span>
          <div className="text-xl font-bold font-mono text-amber-400 mt-1">{pendingShipmentsCount} Deliveries</div>
          <span className="text-[10px] text-slate-400">Warehouse Goods Issue</span>
        </div>
        <div className="hairline-panel p-4 rounded-xl">
          <span className="text-[11px] text-slate-400 font-mono block">OPEN INVOICES</span>
          <div className="text-xl font-bold font-mono text-indigo-400 mt-1">{openInvoicesCount} Invoices</div>
          <span className="text-[10px] text-slate-400">Accounts Receivable (Net 30/45)</span>
        </div>
      </div>

      {/* Workstation Sub-Navigation */}
      <div className="flex border-b border-white/[0.08] space-x-6 text-xs">
        <button
          onClick={() => setSubTab("intake")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer ${
            subTab === "intake" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>RFQ Intake & CTP Promising</span>
        </button>
        <button
          onClick={() => setSubTab("orders")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer ${
            subTab === "orders" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Committed Sales Orders ({props.salesOrders.length})</span>
        </button>
        <button
          onClick={() => setSubTab("deliveries")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer ${
            subTab === "deliveries" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Truck className="w-3.5 h-3.5" />
          <span>Outbound Deliveries ({props.deliveries.length})</span>
        </button>
        <button
          onClick={() => setSubTab("invoices")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer ${
            subTab === "invoices" ? "text-blue-400 border-b-2 border-blue-500" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          <span>Billing & Cash Clearing ({props.invoices.length})</span>
        </button>
        <button
          onClick={() => setSubTab("customers")}
          className={`pb-3 font-semibold transition-colors flex items-center space-x-1.5 cursor-pointer ${
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
            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="font-bold text-xs text-slate-200 flex items-center space-x-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  <span>Cognitive Natural Language RFQ Parser</span>
                </h2>
                <span className="text-[10px] text-slate-400 font-mono">Real-Time CTP Engine</span>
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

              <div className="flex justify-between items-center pt-2">
                <div className="flex space-x-2">
                  {[
                    "Boeing Aerospace requests 20 units of Turbine Housing TB-200 needed by next Friday",
                    "Siemens Energy urgent RFQ: 5 units of Hydraulic Pump PMP-500 needed in 4 days",
                  ].map((preset, idx) => (
                    <button
                      key={idx}
                      onClick={() => props.setPrompt(preset)}
                      className="text-[10px] text-slate-400 hover:text-slate-200 px-2 py-1 bg-white/[0.03] rounded border border-white/[0.06] transition-colors truncate max-w-xs cursor-pointer"
                    >
                      {preset.split(":")[0]}
                    </button>
                  ))}
                </div>
                <button
                  onClick={props.handleEvaluateRFQ}
                  disabled={props.evaluating}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-lg text-xs shadow-sm flex items-center space-x-1.5 transition-all cursor-pointer"
                >
                  {props.evaluating ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Solving CTP Feasibility...</span>
                    </>
                  ) : (
                    <>
                      <span>Evaluate CTP Promise</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Generated Proposal Card */}
            {props.proposal && (
              <div className="hairline-panel-elevated rounded-xl p-5 space-y-4 animate-in fade-in duration-200">
                <div className="flex justify-between items-start border-b border-white/[0.08] pb-3">
                  <div>
                    <span className="text-[10px] font-mono font-bold uppercase text-blue-400">
                      Proposal Ready for Commercial Sign-Off
                    </span>
                    <h3 className="font-bold text-slate-100 text-sm mt-0.5">
                      {props.proposal.parsed_rfq?.customer_name} · {props.proposal.parsed_rfq?.quantity}x{" "}
                      {props.proposal.parsed_rfq?.part_description}
                    </h3>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                    CREDIT APPROVED
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3 text-xs font-mono">
                  <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Total Quotation</span>
                    <span className="text-base font-bold text-slate-100">
                      ${props.proposal.parsed_rfq?.total_price?.toLocaleString()}
                    </span>
                  </div>
                  <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Guaranteed Delivery</span>
                    <span className="text-base font-bold text-emerald-400">
                      {new Date(props.proposal.ctp_evaluation?.earliest_finish).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="bg-[#0a0b0e] p-3 rounded-lg border border-white/[0.06]">
                    <span className="text-[10px] text-slate-400 block">Lead Time Slack</span>
                    <span className="text-base font-bold text-blue-400">
                      +{props.proposal.ctp_evaluation?.slack_hours}h Buffer
                    </span>
                  </div>
                </div>

                <div className="flex justify-between items-center pt-2 border-t border-white/[0.06]">
                  <span className="text-[10px] text-slate-400 font-mono">
                    Token: <strong>{props.proposal.token}</strong>
                  </span>
                  <button
                    onClick={props.handleApprove}
                    disabled={props.approving}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-lg text-xs shadow-sm flex items-center space-x-1.5 transition-all cursor-pointer"
                  >
                    {props.approving ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Signing & Reserving Shop Floor...</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Sign & Commit Sales Order (SO-202611)</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Customer Credit Status */}
          <div className="lg:col-span-5 space-y-4">
            <div className="hairline-panel rounded-xl p-5 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="font-bold text-xs text-slate-200 flex items-center space-x-1.5">
                  <Building2 className="w-3.5 h-3.5 text-blue-400" />
                  <span>Customer Credit Ledger (ERP Live)</span>
                </h2>
                <span className="text-[10px] text-slate-400 font-mono">SOX 404 Guardrail</span>
              </div>

              <div className="space-y-3.5">
                {props.customers.map((c) => {
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
                          className={`h-full rounded-full ${utilPct > 80 ? "bg-amber-500" : "bg-blue-500"}`}
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

      {/* SUBTAB 2: COMMITTED SALES ORDERS */}
      {subTab === "orders" && (
        <div className="hairline-panel rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
            <div>
              <h2 className="font-bold text-sm text-slate-100">Committed Sales Orders Ledger (VBAK / VBAP)</h2>
              <p className="text-xs text-slate-400">Click any record to inspect the complete SAP S/4HANA document flow and printable acknowledgment.</p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => {
                  const rows = props.filteredOrders.map((o) => ({
                    Order_Number: o.order_number,
                    Customer: o.customer_name,
                    Status: o.status,
                    Total_Amount: o.total_amount,
                    Promised_Delivery_Date: o.promised_delivery_date || "",
                    Delivery_Number: o.delivery_number || "",
                    Invoice_Number: o.invoice_number || "",
                  }));
                  props.exportToCsv("sales_orders_pipeline.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 text-xs bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors cursor-pointer"
                title="Download Sales Pipeline as CSV"
              >
                <Download className="w-3 h-3 text-blue-400" />
                <span>Export CSV</span>
              </button>
              <span className="text-xs text-slate-400 font-mono">{props.filteredOrders.length} records</span>
            </div>
          </div>
          {props.filteredOrders.length > 0 ? (
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
                  {props.filteredOrders.map((ord) => (
                    <tr key={ord.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3.5 px-4 font-mono font-medium text-blue-400">{ord.order_number}</td>
                      <td className="py-3.5 px-4 font-semibold text-slate-200">{ord.customer_name}</td>
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800/40">
                          {ord.status}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-100">
                        ${ord.total_amount?.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-300">
                        {ord.promised_delivery_date ? new Date(ord.promised_delivery_date).toLocaleDateString() : "Pending"}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-400">{ord.delivery_number || "—"}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-400">{ord.invoice_number || "—"}</td>
                      <td className="py-3.5 px-4 text-center">
                        <button
                          onClick={() => props.handleViewOrderFlow(ord.id)}
                          className="px-2.5 py-1 bg-white/[0.05] hover:bg-white/[0.1] text-blue-300 rounded font-semibold text-[11px] border border-white/[0.08] flex items-center space-x-1 mx-auto transition-colors cursor-pointer"
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
          ) : (
            <div className="p-12 text-center text-slate-500">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No sales orders found matching "{props.searchQuery}"</p>
            </div>
          )}
        </div>
      )}

      {/* SUBTAB 3: OUTBOUND DELIVERIES */}
      {subTab === "deliveries" && (
        <div className="hairline-panel rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
            <div>
              <h2 className="font-bold text-sm text-slate-100">Outbound Delivery Documents (LIKP / VL01N)</h2>
              <p className="text-xs text-slate-400">Warehouse fulfillment, carrier logistics, and Goods Issue dispatch.</p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => {
                  const rows = props.filteredDeliveries.map((d) => ({
                    Delivery_Number: d.delivery_number,
                    Carrier: d.carrier,
                    Tracking_Number: d.tracking_number || "",
                    Status: d.status,
                    Shipped_At: d.shipped_at || "",
                  }));
                  props.exportToCsv("outbound_deliveries.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 text-xs bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors cursor-pointer"
                title="Download Deliveries as CSV"
              >
                <Download className="w-3 h-3 text-indigo-400" />
                <span>Export CSV</span>
              </button>
              <span className="text-xs text-slate-400 font-mono">{props.filteredDeliveries.length} delivery notes</span>
            </div>
          </div>
          {props.filteredDeliveries.length > 0 ? (
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
                  {props.filteredDeliveries.map((deliv) => (
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
                            onClick={() => props.handleShipDelivery(deliv.id)}
                            disabled={props.actionLoading === deliv.id}
                            className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto transition-all cursor-pointer"
                          >
                            {props.actionLoading === deliv.id ? (
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
          ) : (
            <div className="p-12 text-center text-slate-500">No delivery documents matching active filter.</div>
          )}
        </div>
      )}

      {/* SUBTAB 4: INVOICES & SETTLEMENT */}
      {subTab === "invoices" && (
        <div className="hairline-panel rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/[0.08] flex justify-between items-center">
            <div>
              <h2 className="font-bold text-sm text-slate-100">Customer Billing Documents (VBRK / VF01)</h2>
              <p className="text-xs text-slate-400">Accounts receivable, standard tax ledger, and cash clearing.</p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => {
                  const rows = props.filteredInvoices.map((inv) => ({
                    Invoice_Number: inv.invoice_number,
                    Customer: inv.customer_name,
                    Amount_Due: inv.total_amount,
                    Payment_Status: inv.status,
                    Due_Date: inv.due_date || "",
                    Issued_At: inv.issued_at || "",
                  }));
                  props.exportToCsv("billing_invoices.csv", rows);
                }}
                className="flex items-center space-x-1 px-2.5 py-1 text-xs bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 rounded border border-white/[0.08] transition-colors cursor-pointer"
                title="Download Invoices as CSV"
              >
                <Download className="w-3 h-3 text-emerald-400" />
                <span>Export CSV</span>
              </button>
              <span className="text-xs text-slate-400 font-mono">{props.filteredInvoices.length} invoices</span>
            </div>
          </div>
          {props.filteredInvoices.length > 0 ? (
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
                  {props.filteredInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3.5 px-4 font-mono font-medium text-emerald-400">{inv.invoice_number}</td>
                      <td className="py-3.5 px-4 font-semibold text-slate-200">{inv.customer_name}</td>
                      <td className="py-3.5 px-4 text-right font-mono font-bold text-slate-100">
                        ${inv.total_amount?.toLocaleString()}
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
                            onClick={() => props.handlePayInvoice(inv.id)}
                            disabled={props.actionLoading === inv.id}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold flex items-center space-x-1 mx-auto transition-all cursor-pointer"
                          >
                            {props.actionLoading === inv.id ? (
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
          ) : (
            <div className="p-12 text-center text-slate-500">No invoices matching active query.</div>
          )}
        </div>
      )}

      {/* SUBTAB 5: CUSTOMER DIRECTORY */}
      {subTab === "customers" && (
        <div className="hairline-panel rounded-xl overflow-hidden p-5 space-y-4">
          <h2 className="font-bold text-sm text-slate-100 flex items-center space-x-2">
            <Building2 className="w-4 h-4 text-blue-400" />
            <span>Customer Master Accounts & Credit Profiles</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {props.customers.map((c) => {
              const utilPct = Math.min(100, Math.round((c.current_exposure / c.credit_limit) * 100));
              return (
                <div key={c.id} className="p-4 bg-[#0a0b0e] rounded-xl border border-white/[0.08] space-y-3">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="font-mono text-xs text-blue-400 font-bold">{c.customer_number}</span>
                      <h3 className="font-bold text-slate-100 text-sm mt-0.5">{c.name}</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-white/[0.06] text-slate-300">
                      {c.payment_terms}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-xs font-mono">
                    <div className="flex justify-between text-slate-400">
                      <span>Credit Limit:</span>
                      <span className="font-bold text-slate-200">${c.credit_limit.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Current Exposure:</span>
                      <span className="font-bold text-amber-400">${c.current_exposure.toLocaleString()}</span>
                    </div>
                    <div className="w-full bg-white/[0.08] rounded-full h-1.5 overflow-hidden mt-1">
                      <div className="h-full rounded-full bg-blue-500" style={{ width: `${utilPct}%` }}></div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
