"use client";

import Link from "next/link";
import { listDomesticSalesOrders } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { BookingComposer } from "@/components/request/BookingComposer";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { PageHeader, StatusBadge } from "@/components/ui";
import type { SalesOrder } from "@/types/channels";

export default function DomesticSalesPage() {
  const { items, error } = useLiveList(listDomesticSalesOrders);

  return (
    <>
      <PageHeader
        kicker="DOM·01"
        title="Domestic Sales"
        description="Standard direct orders against real inventory or production — the DIRECT_SALES workflow. Every Sales Order this system has ever created, live below."
      />

      <BookingComposer />

      <RecordsTable
        title="Sales Orders"
        items={items}
        error={error}
        rowKey={(row) => row.sales_order_id}
        columns={[
          {
            header: "ID",
            render: (r) => (
              <Link href={`/domestic-sales/${r.sales_order_id}`} className="mono" style={{ color: "var(--accent)" }}>
                {r.sales_order_id}
              </Link>
            ),
          },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Product", render: (r) => `${r.quantity ?? "—"} x ${r.product_name ?? "—"}` },
          { header: "Total", render: (r) => (r.total_amount != null ? r.total_amount.toLocaleString() : "—") },
          { header: "Deadline", render: (r) => r.requested_deadline ?? "—" },
          {
            header: "Status",
            render: (r) => <StatusBadge tone={r.status === "CREDIT_BLOCKED" ? "danger" : "success"}>{r.status}</StatusBadge>,
          },
          { header: "Created", render: (r) => r.created_at.replace("T", " ").slice(0, 19) },
        ]}
      />
    </>
  );
}
