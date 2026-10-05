"use client";

import { listProjectSales } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { NewRequestBanner } from "@/components/request/NewRequestBanner";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { ProjectMilestoneBoard } from "@/components/channels/ProjectMilestoneBoard";
import { PageHeader, StatusBadge } from "@/components/ui";

const EXAMPLES = [
  "ABC Corp wants to award us a turnkey manufacturing project for a new production line, contract value 800000.",
  "Northgate Traders wants a project engagement for a new facility, contract value 1200000.",
];

export default function ProjectSalesPage() {
  const { items, error } = useLiveList(listProjectSales);

  return (
    <>
      <PageHeader
        kicker="PRJ·06"
        title="Project Sales"
        description="Large, milestone-based engagements — a flat 30/40/30 advance/delivery/final split, 10% retention held back per milestone and released as one settlement on close. See Active Workflows for milestones still waiting on sign-off or billing."
      />

      <NewRequestBanner examples={EXAMPLES} />

      {items && items.length > 0 && <ProjectMilestoneBoard project={items[0]} />}

      <RecordsTable
        title="Projects"
        items={items}
        error={error}
        rowKey={(row) => row.project_id}
        columns={[
          { header: "ID", render: (r) => <span className="mono">{r.project_id}</span> },
          { header: "Customer", render: (r) => r.customer_name ?? "—" },
          { header: "Type", render: (r) => r.project_type },
          { header: "Contract Value", render: (r) => (r.contract_value != null ? r.contract_value.toLocaleString() : "—") },
          { header: "Retention Held", render: (r) => r.retention_held.toLocaleString() },
          { header: "Status", render: (r) => <StatusBadge tone={r.status === "CLOSED" ? "neutral" : "success"}>{r.status}</StatusBadge> },
          { header: "Created", render: (r) => r.created_at.replace("T", " ").slice(0, 19) },
        ]}
      />
    </>
  );
}
