"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listMasterCustomers, listMasterProducts, type MasterCustomer, type MasterProduct } from "@/lib/api";

// A structured "booking screen" — but unlike a traditional ERP form, the
// Submit button doesn't write anything directly. It composes a
// well-formed request from real Customer/Product Master rows and hands
// it to Agent Console, which runs it through the exact same intent →
// credit → stock → human-approval pipeline as if you'd typed it. No
// separate manual-entry code path, no bypassing the agents.
export function BookingComposer() {
  const router = useRouter();
  const [customers, setCustomers] = useState<MasterCustomer[] | null>(null);
  const [products, setProducts] = useState<MasterProduct[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [deadline, setDeadline] = useState("");

  useEffect(() => {
    listMasterCustomers().then(setCustomers).catch(() => setCustomers([]));
    listMasterProducts().then(setProducts).catch(() => setProducts([]));
  }, []);

  const customer = customers?.find((c) => c.customer_id === customerId);
  const product = products?.find((p) => p.product_id === productId);
  const qty = Number(quantity) || 0;
  const canSubmit = Boolean(customer && product && qty > 0);

  function submit() {
    if (!customer || !product || qty <= 0) return;
    const deadlinePart = deadline ? ` by ${deadline}` : "";
    const message = `${customer.customer_name} wants ${qty} ${product.product_name} units${deadlinePart}. Check their credit and stock, then prepare the order for my approval.`;
    router.push(`/agent-console?draft=${encodeURIComponent(message)}`);
  }

  return (
    <div className="panel">
      <div className="panel-title">New sales order</div>
      <div className="panel-sub">
        Fill in the order — Submit sends it through the same AI pipeline as Agent Console (credit
        check, stock check, human approval), just composed from real records instead of typed by hand.
      </div>
      <div className="form-grid">
        <div className="field">
          <label>CUSTOMER</label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{customers ? "Select a customer…" : "Loading…"}</option>
            {customers?.map((c) => (
              <option key={c.customer_id} value={c.customer_id} disabled={!c.active}>
                {c.customer_name}
                {!c.active ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>ITEM</label>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">{products ? "Select a product…" : "Loading…"}</option>
            {products?.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {p.product_name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>QUANTITY</label>
          <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 50" />
        </div>
        <div className="field">
          <label>CATALOG RATE</label>
          <input
            value={product ? `₹${product.price.toLocaleString()} / unit` : "— select an item —"}
            disabled
            style={{ opacity: 0.7 }}
          />
        </div>
        <div className="field">
          <label>REQUESTED DEADLINE (OPTIONAL)</label>
          <input value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="e.g. October, or a date" />
        </div>
        <div className="field">
          <label>ORDER VALUE</label>
          <input value={product && qty > 0 ? `₹${(product.price * qty).toLocaleString()}` : "—"} disabled style={{ opacity: 0.7 }} />
        </div>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" disabled={!canSubmit} onClick={submit}>
          Submit for credit check →
        </button>
      </div>
    </div>
  );
}
