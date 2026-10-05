"use client";

import { listExportSalesOrders } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { ExportDocChecklist } from "@/components/channels/ExportDocChecklist";
import { PageHeader, StatusBadge } from "@/components/ui";

const EXAMPLES = [
  "ABC Corp wants to export 20 Wireless Mouse units to Germany, terms FOB.",
  "Northgate Traders wants to export 10 External SSD 1TB drives to Japan, terms CIF.",
];

const TERMINAL = new Set(["CLOSED"]);

export default function ExportSalesPage() {
  const { items, error } = useLiveList(listExportSalesOrders);

  return (
    <>
      <PageHeader
        kicker="EXP·02"
        title="Export Sales"
        description="Cross-border orders — proforma invoice on confirmation, then payment verification, allocation, documentation, freight, shipment, and the commercial invoice, each a real operational step. Every Export Order below, oldest transitions first within each row."
      />

      <NewRequestBanner examples={EXAMPLES} />

      {items && items.length > 0 && <ExportDocChecklist order={items[0]} />}

      <RecordsTable
        title="Export Orders"
        items={items}
        error={error}
        rowKey={(row) => row.export_order_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.export_order_id}</span> },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Product", render: (r) => `${r.quantity ?? "—"} x ${r.product_name ?? "—"}` },
          { header: "Destination", render: (r) => `${r.destination_country ?? "—"}${r.incoterm ? ` (${r.incoterm})` : ""}` },
          { header: "Value", render: (r) => (r.total_value != null ? r.total_value.toLocaleString() : "—") },
          {
            header: "Status",
            render: (r) => <StatusBadge tone={TERMINAL.has(r.status) ? "neutral" : "warning"}>{r.status}</StatusBadge>,
          },
          { header: "Created", render: (r) => r.created_at.replace("T", " ").slice(0, 19) },
        ]}
      />
    </>
  );
}
