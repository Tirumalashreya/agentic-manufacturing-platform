"use client";

import { useEffect, useState } from "react";
import { listDomesticSalesOrders, listTradingOrders } from "@/lib/api";
import type { SalesOrder, TradingOrder } from "@/types/channels";

type MarginRow = TradingOrder & { sellingPrice: number | null; marginPercent: number | null };

// The resale margin isn't a stored field anywhere — it's the real
// selling price on the linked Sales Order (the same product-master
// price the domestic pipeline uses) against this Trading Order's real
// vendor cost. A join across two live tables, not a fabricated number.
function joinMargins(trading: TradingOrder[], salesOrders: SalesOrder[]): MarginRow[] {
  const byId = new Map(salesOrders.map((s) => [s.sales_order_id, s]));
  return trading.map((t) => {
    const linked = t.sales_order_id ? byId.get(t.sales_order_id) : undefined;
    const sellingPrice = linked?.unit_price ?? null;
    const marginPercent =
      sellingPrice && sellingPrice > 0 ? ((sellingPrice - t.unit_cost) / sellingPrice) * 100 : null;
    return { ...t, sellingPrice, marginPercent };
  });
}

export function TradingMarginsBoard() {
  const [rows, setRows] = useState<MarginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTradingOrders(), listDomesticSalesOrders()])
      .then(([trading, sales]) => !cancelled && setRows(joinMargins(trading, sales)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load margins."));
    return () => {
      cancelled = true;
    };
  }, []);

  const withMargin = rows?.filter((r) => r.marginPercent != null) ?? [];

  return (
    <div className="panel">
      <div className="panel-title">Traded item margins</div>
      <div className="panel-sub">
        Vendor cost (this Trading Order) against the linked Sales Order&apos;s real selling price —
        only shown where that link resolves.
      </div>
      {error && <p style={{ color: "var(--alert)", fontSize: 12.5 }}>{error}</p>}
      {rows && withMargin.length === 0 && (
        <p style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
          No trading order here has a resolvable linked Sales Order yet.
        </p>
      )}
      {withMargin.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Item</th>
              <th>Vendor</th>
              <th>Cost</th>
              <th>Selling price</th>
              <th>Margin</th>
              <th>Stock</th>
            </tr>
          </thead>
          <tbody>
            {withMargin.map((r) => (
              <tr key={r.trading_order_id}>
                <td>{r.product_name}</td>
                <td>{r.vendor_name}</td>
                <td className="mono">₹{r.unit_cost.toLocaleString()}</td>
                <td className="mono">₹{r.sellingPrice!.toLocaleString()}</td>
                <td>
                  <span className={`chip ${r.marginPercent! >= 20 ? "ok" : r.marginPercent! >= 10 ? "warn" : "bad"}`}>
                    {r.marginPercent!.toFixed(1)}%
                  </span>
                </td>
                <td className="mono">{r.quantity} u</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
