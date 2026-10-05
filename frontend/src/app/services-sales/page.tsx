"use client";

import { listServicesSalesOrders } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { PageHeader, StatusBadge } from "@/components/ui";

const EXAMPLES = [
  "ABC Corp needs installation of 20 machines at their Hyderabad plant.",
  "XYZ Industries would like to hire consultants to review their production line efficiency.",
];

export default function ServicesSalesPage() {
  const { items, error } = useLiveList(listServicesSalesOrders);

  return (
    <>
      <PageHeader
        kicker="SVC·03"
        title="Services Sales"
        description="Labor/consulting engagements billed by a fixed rate or actual hours — no physical product involved. Real transitions only: REQUESTED → SCHEDULED → IN_PROGRESS → COMPLETED, no time-based auto-progress."
      />

      <NewRequestBanner examples={EXAMPLES} />

      <RecordsTable
        title="Service Orders"
        items={items}
        error={error}
        rowKey={(row) => row.service_order_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.service_order_id}</span> },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Type", render: (r) => r.service_type },
          { header: "Rate", render: (r) => (r.rate != null ? `${r.rate.toLocaleString()} (${r.rate_type ?? "?"})` : "—") },
          { header: "Billable", render: (r) => (r.billable_amount != null ? r.billable_amount.toLocaleString() : "—") },
          { header: "Status", render: (r) => <StatusBadge tone="warning">{r.status ?? "UNKNOWN"}</StatusBadge> },
          { header: "Created", render: (r) => (r.created_at ? r.created_at.replace("T", " ").slice(0, 19) : "—") },
        ]}
      />
    </>
  );
}
