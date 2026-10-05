import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CreateOrderForm } from "@/components/CreateOrderForm";
import { DeleteOrderButton } from "@/components/DeleteOrderButton";
import { orderStatusTone } from "@/lib/statusTone";

export const metadata: Metadata = { title: "Production orders" };

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const [orders, products, routings] = await Promise.all([
    selectedPlant
      ? prisma.productionOrder.findMany({
          where: { plantId: selectedPlant.id },
          include: { product: true, salesOrder: { include: { customer: true } } },
          orderBy: { priorityScore: "desc" },
        })
      : Promise.resolve([]),
    prisma.product.findMany({ orderBy: { sku: "asc" } }),
    prisma.routing.findMany({ include: { product: true } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Production orders" />

      {selectedPlant && (
        <Card>
          <h2 className="text-sm font-semibold text-foreground">New order</h2>
          <div className="mt-4">
            <CreateOrderForm plantId={selectedPlant.id} products={products} routings={routings} />
          </div>
        </Card>
      )}

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">Priority score</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Scheduled end</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orders.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted">No orders yet.</td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={order.id}>
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/orders/${order.id}`} className="text-brand-600 hover:underline">
                      {order.product.sku}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted">{order.salesOrder?.customer.name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{order.quantity}</td>
                  <td className="px-4 py-3 text-muted">{order.priorityScore.toFixed(1)}</td>
                  <td className="px-4 py-3"><StatusBadge tone={orderStatusTone(order.status)}>{order.status}</StatusBadge></td>
                  <td className="px-4 py-3 text-muted">
                    {order.scheduledEnd ? new Date(order.scheduledEnd).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <DeleteOrderButton orderId={order.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
