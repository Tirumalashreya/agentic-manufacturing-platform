"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteOrderAction } from "@/app/(app)/actions";

// Hard delete, so it asks once before doing it — unlike Cancel (soft,
// reversible-in-spirit since the row stays for history), this removes the
// order and every scheduled operation against it for good.
export function DeleteOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteOrderAction(orderId);
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.refresh();
    });
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={isPending}
          onClick={handleDelete}
          className="rounded-md bg-danger px-2 py-1 text-xs font-medium text-white hover:brightness-95 disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Confirm delete"}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded-md bg-surface-muted px-2 py-1 text-xs font-medium text-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-danger-soft hover:text-danger"
      >
        Delete
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
