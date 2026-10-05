"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { createVendorAction, createPurchaseOrderAction, receivePurchaseOrderAction, linkVendorProductAction } from "@/app/(app)/actions";
import type { Vendor, PurchaseOrderSummary } from "@/lib/services";

type ProductOption = { id: string; sku: string };
type PlantOption = { id: string; code: string };

// Real Material Lifecycle UI (Phase 3, agreed with the user) — the only
// place any of Vendor/PurchaseOrder creation or Goods Receipt can be
// triggered from; none of this had any UI before this round (the routes
// for vendor/PO creation already existed and worked, just with nothing in
// front of them).
export function MaterialsPanel({
  vendors,
  purchaseOrders,
  products,
  plants,
  defaultLocation,
}: {
  vendors: Vendor[];
  purchaseOrders: PurchaseOrderSummary[];
  products: ProductOption[];
  plants: PlantOption[];
  defaultLocation: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [vendorName, setVendorName] = useState("");
  const [vendorLeadTime, setVendorLeadTime] = useState(7);

  const [selectedVendorId, setSelectedVendorId] = useState(vendors[0]?.id ?? "");
  const [selectedProductId, setSelectedProductId] = useState(products[0]?.id ?? "");
  const [poQuantity, setPoQuantity] = useState(100);
  const [expectedDate, setExpectedDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });

  const [receiveLocationByPo, setReceiveLocationByPo] = useState<Record<string, string>>({});

  // Real per-component vendor data (Phase 7, agreed with the user) — the
  // real gap this closes: Vendor previously had no product/component
  // relation at all, so procurement always picked one globally-cheapest
  // vendor for every shortage line regardless of which component it
  // actually was.
  const [linkVendorId, setLinkVendorId] = useState(vendors[0]?.id ?? "");
  const [linkProductId, setLinkProductId] = useState(products[0]?.id ?? "");
  const [linkLeadTime, setLinkLeadTime] = useState(7);
  const [linkUnitCost, setLinkUnitCost] = useState(10);

  function run(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      setMessage(label);
      router.refresh();
    });
  }

  const openPurchaseOrders = purchaseOrders.filter((po) => !po.receivedAt);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Purchasing</h2>
        <p className="mt-1 text-xs text-muted">
          Create a vendor and purchase order, then receive it into real stock — the same real routes the
          procurement flow already uses, just with a UI in front of them for the first time.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">New vendor</p>
          <input
            type="text"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
            placeholder="Vendor name"
            className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
          />
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={vendorLeadTime}
              onChange={(e) => setVendorLeadTime(Math.max(0, Number(e.target.value)))}
              className="h-9 w-24 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            />
            <span className="text-xs text-muted">lead time (days)</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={isPending || !vendorName}
            onClick={() =>
              run("Vendor created.", () => createVendorAction({ name: vendorName, leadTimeDays: vendorLeadTime }))
            }
          >
            Create vendor
          </Button>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">New purchase order</p>
          {vendors.length === 0 || products.length === 0 ? (
            <p className="text-xs text-muted">Create a vendor first (and a product must exist).</p>
          ) : (
            <>
              <select
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <select
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={poQuantity}
                  onChange={(e) => setPoQuantity(Math.max(1, Number(e.target.value)))}
                  className="h-9 w-24 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                />
                <input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                  className="h-9 flex-1 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={isPending || !selectedVendorId || !selectedProductId}
                onClick={() =>
                  run("Purchase order created.", () =>
                    createPurchaseOrderAction({
                      vendorId: selectedVendorId,
                      productId: selectedProductId,
                      quantity: poQuantity,
                      expectedDate,
                    })
                  )
                }
              >
                Create purchase order
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">Link vendor to component</p>
          <p className="text-[11px] text-muted">
            Real per-component pricing/lead-time — without this, procurement can only pick one vendor for every shortage.
          </p>
          {vendors.length === 0 || products.length === 0 ? (
            <p className="text-xs text-muted">Create a vendor first (and a product must exist).</p>
          ) : (
            <>
              <select
                value={linkVendorId}
                onChange={(e) => setLinkVendorId(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <select
                value={linkProductId}
                onChange={(e) => setLinkProductId(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-0.5 text-[11px] text-muted">
                  Lead time (days)
                  <input
                    type="number"
                    min={0}
                    value={linkLeadTime}
                    onChange={(e) => setLinkLeadTime(Math.max(0, Number(e.target.value)))}
                    className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                  />
                </label>
                <label className="flex flex-1 flex-col gap-0.5 text-[11px] text-muted">
                  Unit cost
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={linkUnitCost}
                    onChange={(e) => setLinkUnitCost(Math.max(0, Number(e.target.value)))}
                    className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                  />
                </label>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={isPending || !linkVendorId || !linkProductId}
                onClick={() =>
                  run("Vendor linked to component.", () =>
                    linkVendorProductAction(linkVendorId, { productId: linkProductId, leadTimeDays: linkLeadTime, unitCost: linkUnitCost })
                  )
                }
              >
                Link vendor
              </Button>
            </>
          )}
        </div>
      </div>

      {openPurchaseOrders.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">Open purchase orders — receive into stock</p>
          <div className="flex flex-col gap-2">
            {openPurchaseOrders.map((po) => (
              <div key={po.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-foreground">{po.productSku} · qty {po.quantity} from {po.vendorName}</span>
                <select
                  value={receiveLocationByPo[po.id] ?? defaultLocation}
                  onChange={(e) => setReceiveLocationByPo((prev) => ({ ...prev, [po.id]: e.target.value }))}
                  className="h-8 rounded-md border border-border bg-surface px-1.5 text-xs text-foreground"
                >
                  {plants.map((p) => (
                    <option key={p.id} value={p.code}>{p.code}</option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isPending}
                  onClick={() =>
                    run("Purchase order received — inventory updated.", () =>
                      receivePurchaseOrderAction(po.id, receiveLocationByPo[po.id] ?? defaultLocation)
                    )
                  }
                >
                  Receive
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}
    </div>
  );
}
