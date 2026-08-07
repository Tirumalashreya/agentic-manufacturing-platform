"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteOperatorAction } from "@/app/(app)/actions";

// Hard delete, so it asks once before doing it. Any real scheduled work
// this operator was on gets unassigned (falls back to machine-only), not
// deleted — see operator-service's DELETE handler.
export function DeleteOperatorButton({ operatorId }: { operatorId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteOperatorAction(operatorId);
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
          className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Confirm"}
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
        className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
      >
        Delete
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
