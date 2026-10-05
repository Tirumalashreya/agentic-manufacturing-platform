"use client";

import { listReturns } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { PageHeader, StatusBadge } from "@/components/ui";

const EXAMPLES = [
  "ABC Corp wants to return 2 Wireless Mouse units from a recent order, product arrived damaged.",
  "Issue a credit memo to XYZ Industries for an overcharge on their last invoice.",
];

export default function ReturnsPage() {
  const { items, error } = useLiveList(listReturns);

  return (
    <>
      <PageHeader
        kicker="RET·04"
        title="Returns"
        description={
          <>
            The Post-Sales workflow: product returns (pending physical inspection before stock/credit
            is granted), plus order-tied credit and debit memos — one shared table for all three,
            shown together rather than hiding two of them behind a page called only &quot;Returns&quot;.
          </>
        }
      />

      <NewRequestBanner examples={EXAMPLES} />

      <RecordsTable
        title="Post-Sales Actions"
        items={items}
        error={error}
        rowKey={(row) => row.post_sales_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.post_sales_id}</span> },
          { header: "Action", render: (r) => <StatusBadge tone="neutral">{r.action}</StatusBadge> },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Order Ref", render: (r) => <span className="mono">{r.referenced_order_id ?? "—"}</span> },
          { header: "Product", render: (r) => (r.product_name ? `${r.quantity ?? "—"} x ${r.product_name}` : "—") },
          { header: "Amount", render: (r) => (r.amount != null ? r.amount.toLocaleString() : "—") },
          {
            header: "Status",
            render: (r) => (
              <StatusBadge tone={r.status === "REJECTED" ? "danger" : r.status === "PENDING_INSPECTION" ? "warning" : "success"}>
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
