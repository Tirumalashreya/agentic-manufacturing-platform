"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { createOrderAction } from "@/app/(app)/actions";

type Product = { id: string; sku: string };
type Routing = { id: string; productId: string; version: string };

export function CreateOrderForm({
  plantId,
  products,
  routings,
}: {
  plantId: string;
  products: Product[];
  routings: Routing[];
}) {
  const router = useRouter();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const matchingRouting = routings.find((r) => r.productId === productId);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createOrderAction({ plantId, productId, routingId: matchingRouting?.id, quantity });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (products.length === 0) {
    return <p className="text-sm text-muted">No products defined yet — create one via routing-service first.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="productId" className="text-sm font-medium text-foreground">Product</label>
        <select
          id="productId"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.sku}</option>
          ))}
        </select>
      </div>
      <div className="w-32">
        <Input
          name="quantity"
          label="Quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Creating..." : "Create order"}
      </Button>
    </form>
  );
}
