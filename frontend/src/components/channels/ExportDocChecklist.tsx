import type { ExportOrder } from "@/types/channels";

type ChecklistItem = { label: string; done: boolean; note: string };

// Every item here is a real column on the ExportOrder row (see
// export_tools.py's EXPORT_ORDER_HEADERS / _TRANSITIONS) — presence of
// the reference number IS the checklist state, nothing is inferred or
// invented on top of it.
function buildChecklist(order: ExportOrder): ChecklistItem[] {
  return [
    {
      label: "Proforma invoice",
      done: Boolean(order.proforma_invoice_id),
      note: order.proforma_invoice_id ? `Issued — ${order.proforma_invoice_id}` : "Not yet issued",
    },
    {
      label: "Payment verification",
      done: Boolean(order.payment_reference),
      note: order.payment_reference ? `Verified — ref ${order.payment_reference}` : "Awaiting payment reference",
    },
    {
      label: "Customs declaration",
      done: Boolean(order.customs_declaration_no),
      note: order.customs_declaration_no ? `Filed — ${order.customs_declaration_no}` : "Awaiting customs clearance",
    },
    {
      label: "Freight booking",
      done: Boolean(order.freight_booking_ref),
      note: order.freight_booking_ref ? `Booked — ${order.freight_booking_ref}` : "Not yet booked",
    },
    {
      label: "Bill of lading / AWB",
      done: Boolean(order.bl_awb_number),
      note: order.bl_awb_number ? `Issued — ${order.bl_awb_number}` : "Not yet issued",
    },
  ];
}

export function ExportDocChecklist({ order }: { order: ExportOrder }) {
  const checklist = buildChecklist(order);
  return (
    <div className="panel">
      <div className="panel-title">Documentation checklist — {order.export_order_id}</div>
      <div className="panel-sub">
        {order.customer_name}, {order.destination_country} · most recent export order
      </div>
      <div className="kv-grid" style={{ gridTemplateColumns: "1fr" }}>
        {checklist.map((item) => (
          <div className="kv" key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="kv-label" style={{ fontSize: 12, color: "var(--text)" }}>
              {item.label.toUpperCase()}
            </div>
            <span className={`chip ${item.done ? "ok" : "neutral"}`}>{item.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
