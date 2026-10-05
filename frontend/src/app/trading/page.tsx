"use client";

import { listTradingOrders } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { TradingMarginsBoard } from "@/components/channels/TradingMarginsBoard";
import { PageHeader, StatusBadge } from "@/components/ui";

// Trading isn't its own entry_type — it's a fulfillment strategy under
// Direct Sales (see PLAN.md), chosen automatically when a Sales Order
// can't be covered from stock or production and a real vendor exists for
// that finished product. There's no "place a trading order" phrasing;
// this example just gives the fulfillment engine a reason to pick it.
const EXAMPLES = [
  "ABC Corp wants to order 500 Webcam HD units urgently, more than we can produce or stock in time.",
];

export default function TradingPage() {
  const { items, error } = useLiveList(listTradingOrders);

  return (
    <>
      <PageHeader
        kicker="TRD·07"
        title="Trading"
        description={
          <>
            Finished goods bought from a real vendor and resold rather than manufactured — an internal
            sourcing decision, not something a customer explicitly asks for. Triggered automatically
            when Direct Sales fulfillment can&apos;t cover an order from stock or production.
            ORDERED → RECEIVED → QC_PASSED/QC_FAILED → WAREHOUSED → DISPATCHED.
          </>
        }
      />

      <NewRequestBanner examples={EXAMPLES} />

      <TradingMarginsBoard />

      <RecordsTable
        title="Trading Orders"
        items={items}
        error={error}
        rowKey={(row) => row.trading_order_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.trading_order_id}</span> },
          { header: "Sales Order", render: (r) => <span className="mono">{r.sales_order_id ?? "—"}</span> },
          { header: "Product", render: (r) => `${r.quantity} x ${r.product_name}` },
          { header: "Vendor", render: (r) => r.vendor_name },
          { header: "Total Cost", render: (r) => r.total_cost.toLocaleString() },
          {
            header: "Status",
            render: (r) => (
              <StatusBadge tone={r.status === "QC_FAILED" ? "danger" : r.status === "DISPATCHED" ? "neutral" : "warning"}>
                {r.status}
              </StatusBadge>
            ),
          },
          { header: "Created", render: (r) => r.created_at.replace("T", " ").slice(0, 19) },
        ]}
      />
    </>
  );
}
