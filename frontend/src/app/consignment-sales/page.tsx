"use client";

import { listConsignmentSales } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { PageHeader, StatusBadge } from "@/components/ui";

const EXAMPLES = [
  "Send 20 Wireless Mouse units to Northgate Traders to sell on consignment.",
  "Transfer 15 External SSD 1TB drives to XYZ Industries on consignment.",
];

export default function ConsignmentSalesPage() {
  const { items, error } = useLiveList(listConsignmentSales);

  return (
    <>
      <PageHeader
        kicker="CON·05"
        title="Consignment Sales"
        description="Stock transferred to a consignee to hold and sell on our behalf — not a sale, no invoice, until the consignee actually reports a sale. Unsold stock can come back; nothing closes until every unit sent is accounted for, sold or returned."
      />

      <NewRequestBanner examples={EXAMPLES} />

      <RecordsTable
        title="Consignments"
        items={items}
        error={error}
        rowKey={(row) => row.consignment_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.consignment_id}</span> },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Product", render: (r) => r.product_name ?? "—" },
          { header: "Sent", render: (r) => r.quantity_sent },
          { header: "Sold", render: (r) => r.quantity_sold },
          { header: "Returned", render: (r) => r.quantity_returned },
          { header: "Remaining", render: (r) => r.quantity_remaining },
          {
            header: "Value Sold",
            render: (r) => (r.unit_price != null ? `₹${(r.quantity_sold * r.unit_price).toLocaleString()}` : "—"),
          },
          { header: "Status", render: (r) => <StatusBadge tone={r.status === "CLOSED" ? "neutral" : "success"}>{r.status}</StatusBadge> },
        ]}
      />
    </>
  );
}
