"use client";

import { useState } from "react";
import { listInvoices, markInvoicePaid } from "@/lib/api";
import { useLiveList } from "@/lib/useLiveList";
import { RecordsTable } from "@/components/channels/RecordsTable";
import { PageHeader, MetricCard, MetricGrid, ErrorState, StatusBadge, Button, ConfirmDialog } from "@/components/ui";

export default function BillingPage() {
  const { items, error, refresh } = useLiveList(listInvoices);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  async function handleMarkPaid(invoiceId: string) {
    setBusyId(invoiceId);
    setActionError(null);
    try {
      await markInvoicePaid(invoiceId);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not mark this invoice paid.");
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  }

  const totalIssued = (items ?? []).filter((i) => i.status === "ISSUED").reduce((a, i) => a + i.invoice_amount, 0);
  const totalPaid = (items ?? []).filter((i) => i.status === "PAID").reduce((a, i) => a + i.invoice_amount, 0);

  return (
    <>
      <PageHeader
        kicker="BILLING"
        title="Billing & Collections"
        description={
          <>
            The &quot;Cash&quot; half of Order-to-Cash — every invoice this system has ever created, from every
            channel. Real records, not a summary of them.
          </>
        }
      />

      {items && items.length > 0 && (
        <MetricGrid>
          <MetricCard label="Outstanding (Issued)" value={`₹${totalIssued.toLocaleString()}`} note="Invoiced, not yet marked paid" />
          <MetricCard label="Collected (Paid)" value={`₹${totalPaid.toLocaleString()}`} note='The actual "Cash" in Order-to-Cash' />
        </MetricGrid>
      )}

      {actionError && <ErrorState title="Could not mark this invoice paid" description={actionError} />}

      <div style={{ marginTop: 20 }}>
        <RecordsTable
          title="Invoices"
          items={items}
          error={error}
          rowKey={(row) => row.invoice_id}
          emptyMessage="No invoices created yet — approve and complete an order to see one here."
          columns={[
            { header: "ID", render: (r) => <span className="mono">{r.invoice_id}</span> },
            { header: "Order", render: (r) => <span className="mono">{r.sales_order_id ?? "—"}</span> },
            { header: "Customer", render: (r) => r.customer_name ?? "—" },
            { header: "Qty × Rate", render: (r) => `${r.quantity_billed} × ₹${r.unit_price.toLocaleString()}` },
            { header: "Amount", render: (r) => `₹${r.invoice_amount.toLocaleString()}` },
            { header: "Due", render: (r) => r.due_date },
            {
              header: "Status / Action",
              render: (r) =>
                r.status === "PAID" ? (
                  <StatusBadge tone="success">PAID</StatusBadge>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusBadge tone="warning">ISSUED</StatusBadge>
                    <Button variant="secondary" disabled={busyId === r.invoice_id} onClick={() => setConfirmingId(r.invoice_id)}>
                      {busyId === r.invoice_id ? "Marking…" : "Mark Paid"}
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      </div>

      {/* Real, honest confirmation (redesign pass, Phase 11) — this
      session's own billing audit confirmed there is no real payment
      transaction lifecycle anywhere in this system: "Mark Paid" is a
      single status-field write with no amount/method/reference captured
      or stored. This dialog says so plainly instead of implying a real
      payment was processed. */}
      <ConfirmDialog
        open={confirmingId !== null}
        title="Mark this invoice as paid?"
        description="This records the invoice as paid in our system. No payment amount, method, or reference is tracked — that capability doesn't exist yet."
        confirmLabel="Mark as paid"
        onConfirm={() => confirmingId && handleMarkPaid(confirmingId)}
        onCancel={() => setConfirmingId(null)}
      />
    </>
  );
}
