import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchVendors, fetchPurchaseOrders, fetchInventoryMovements, fetchShortages, fetchVendorsForProduct } from "@/lib/services";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { MaterialsPanel } from "@/components/MaterialsPanel";

export const metadata: Metadata = { title: "Materials" };

// Real Material Lifecycle (Phase 3, agreed with the user) — the first page
// for Inventory/Vendor/Purchase Order anywhere in this app; none existed
// before this round. Same plant-selector pattern as production-planning/
// schedule (see those pages' own doc comments for why the anonymous
// fallback exists).
export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Materials" />
        <EmptyState title="No plants exist yet" />
      </div>
    );
  }

  const [inventory, vendors, purchaseOrders, movements, products, shortagesResult] = await Promise.all([
    // Plain read — direct Prisma per this file's own convention (see
    // services.ts's header comment), same as production-planning's
    // ScheduledOperation table. Inventory.location is a free-text
    // plant-code convention (matching the seed script), not a real FK.
    prisma.inventory.findMany({
      where: { location: selectedPlant.code },
      include: { product: { select: { sku: true } } },
      orderBy: { productId: "asc" },
    }),
    fetchVendors(),
    fetchPurchaseOrders(),
    fetchInventoryMovements(selectedPlant.code),
    prisma.product.findMany({ orderBy: { sku: "asc" }, select: { id: true, sku: true } }),
    // Real shortage scan (Phase 8 discoverability pass, agreed with the
    // user) — the exact route inventory-service's own Kafka consumer
    // already runs automatically on every real order creation, previously
    // never called by any page — a planner had no way to see "what's
    // short right now" without doing the BOM math themselves.
    fetchShortages(),
  ]);

  const skuByProductId = new Map(products.map((p) => [p.id, p.sku]));

  // Real per-component vendor links (Phase 7 data, previously write-only —
  // MaterialsPanel's "Link vendor" form could create a VendorProduct row
  // but nothing ever showed which ones already exist). Scoped to the
  // products already visible in the Inventory table below, not every
  // product in the catalog, so this stays a small, relevant read.
  const vendorLinksByProduct = await Promise.all(
    inventory.map(async (i) => ({ productId: i.productId, sku: i.product.sku, vendors: await fetchVendorsForProduct(i.productId) }))
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Materials"
        actions={
          plants.length > 0 ? (
            <form method="get" className="flex items-center gap-2">
              <select
                name="plantId"
                defaultValue={selectedPlant.id}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>{p.code}</option>
                ))}
              </select>
              <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">Switch</button>
            </form>
          ) : undefined
        }
      />

      <MaterialsPanel
        vendors={vendors}
        purchaseOrders={purchaseOrders}
        products={products}
        plants={plants.map((p) => ({ id: p.id, code: p.code }))}
        defaultLocation={selectedPlant.code}
      />

      {/* Real shortage scan (Phase 8 discoverability pass) — previously
      computed automatically on every order creation but shown nowhere;
      this is the first time a planner can see it without doing the BOM
      math themselves. */}
      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Shortages</h2>
          <p className="mt-1 text-xs text-muted">Real, plant-wide — components short against currently open (PLANNED/RELEASED) production orders.</p>
        </div>
        {!shortagesResult.ok ? (
          <div className="px-4 py-4"><ErrorState title="Inventory service unavailable" description={shortagesResult.error} /></div>
        ) : shortagesResult.data.length === 0 ? (
          <EmptyState title="No shortages" description="Nothing short against open orders right now." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">Component</th>
                  <th className="px-3 py-2">Required</th>
                  <th className="px-3 py-2">Available</th>
                  <th className="px-3 py-2">Short by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shortagesResult.data.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-medium text-foreground">{skuByProductId.get(s.productId) ?? s.productId}</td>
                    <td className="px-3 py-2 text-muted">{s.required}</td>
                    <td className="px-3 py-2 text-muted">{s.available}</td>
                    <td className="px-3 py-2">
                      <StatusBadge tone="danger">{s.required - s.available}</StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Inventory — {selectedPlant.code}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Unrestricted</th>
                  <th className="px-3 py-2">Reserved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inventory.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted">No inventory at this location yet.</td>
                  </tr>
                ) : (
                  inventory.map((i) => (
                    <tr key={i.id}>
                      <td className="px-3 py-2 font-medium text-foreground">{i.product.sku}</td>
                      <td className="px-3 py-2 text-muted">{i.qtyUnrestricted}</td>
                      <td className="px-3 py-2 text-muted">{i.qtyReserved}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Purchase Orders</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">Vendor</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Expected</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {purchaseOrders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted">No purchase orders yet.</td>
                  </tr>
                ) : (
                  purchaseOrders.map((po) => (
                    <tr key={po.id}>
                      <td className="px-3 py-2 text-muted">{po.vendorName}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{po.productSku}</td>
                      <td className="px-3 py-2 text-muted">{po.quantity}</td>
                      <td className="px-3 py-2 text-muted">{new Date(po.expectedDate).toLocaleDateString()}</td>
                      <td className="px-3 py-2">
                        <StatusBadge tone={po.receivedAt ? "success" : "neutral"}>
                          {po.receivedAt ? "Received" : "Open"}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Real per-component vendor links (Phase 7 data) — previously
      write-only via MaterialsPanel's "Link vendor" form; this is the first
      read-back so a planner can see what's already linked. */}
      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Linked Vendors</h2>
          <p className="mt-1 text-xs text-muted">Real per-component vendor/lead-time data — used automatically when a production plan picks a vendor for a short component.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
              <tr>
                <th className="px-3 py-2">Component</th>
                <th className="px-3 py-2">Vendor</th>
                <th className="px-3 py-2">Lead time</th>
                <th className="px-3 py-2">Unit cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {vendorLinksByProduct.every((p) => p.vendors.length === 0) ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">No components linked to a specific vendor yet — link one below.</td>
                </tr>
              ) : (
                vendorLinksByProduct.flatMap((p) =>
                  p.vendors.map((v) => (
                    <tr key={`${p.productId}-${v.id}`}>
                      <td className="px-3 py-2 font-medium text-foreground">{p.sku}</td>
                      <td className="px-3 py-2 text-muted">{v.name}</td>
                      <td className="px-3 py-2 text-muted">{v.leadTimeDays}d</td>
                      <td className="px-3 py-2 text-muted">{v.unitCost}</td>
                    </tr>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Inventory Movements — {selectedPlant.code}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted">No movements yet.</td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2 text-muted">{new Date(m.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={m.type === "GOODS_RECEIPT" ? "success" : "warning"}>
                        {m.type.replaceAll("_", " ")}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">{m.productSku}</td>
                    <td className="px-3 py-2 text-muted">{m.quantity}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      {m.purchaseOrderId ? `PO ${m.purchaseOrderId.slice(-8)}` : m.productionOrderId ? `Order ${m.productionOrderId.slice(-8)}` : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
