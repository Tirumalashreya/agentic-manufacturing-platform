"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  triggerMachineBreakdownAction,
  repairMachineAction,
  cancelOrderAction,
  changeOrderQuantityAction,
  toggleDemoTickerAction,
} from "@/app/(app)/actions";

type MachineOption = { id: string; name: string; status: string };
type OrderOption = { id: string; productSku: string; quantity: number; status: string };

// UI front-end for §14's real event-driven rescheduling triggers — these
// buttons fire the SAME real Kafka events (machine breakdown, order
// cancellation, order quantity change) that a real MES/ERP integration
// would, so the automatic reschedule that follows on /schedule is a
// genuine demonstration, not a staged effect.
export function DisruptionSimulator({
  machines,
  orders,
  initialTickerEnabled,
}: {
  machines: MachineOption[];
  orders: OrderOption[];
  initialTickerEnabled: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tickerEnabled, setTickerEnabled] = useState(initialTickerEnabled);

  const [selectedMachine, setSelectedMachine] = useState(machines[0]?.id ?? "");
  const [faultCode, setFaultCode] = useState("MECH-FAIL");
  const [durationMinutes, setDurationMinutes] = useState(120);

  const [selectedOrder, setSelectedOrder] = useState(orders[0]?.id ?? "");
  const [newQuantity, setNewQuantity] = useState(orders[0]?.quantity ?? 1);

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

  function handleToggleTicker() {
    const next = !tickerEnabled;
    startTransition(async () => {
      const result = await toggleDemoTickerAction(next);
      if (result.ok) setTickerEnabled(result.enabled);
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Disruption simulator</h2>
          <p className="mt-1 text-xs text-muted">
            Trigger a real shop-floor event — the same automatic rescheduling (§14) a real breakdown,
            cancellation, or quantity change would set off.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted">
          Demo auto-progress ticker
          <button
            type="button"
            role="switch"
            aria-checked={tickerEnabled}
            onClick={handleToggleTicker}
            disabled={isPending}
            className={`relative h-5 w-9 rounded-full transition-colors ${tickerEnabled ? "bg-brand-600" : "bg-surface-muted"}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${tickerEnabled ? "translate-x-4.5" : "translate-x-0.5"}`}
            />
          </button>
        </label>
      </div>

      {machines.length === 0 && orders.length === 0 ? (
        <p className="text-xs text-muted">No machines or orders yet — create some to try disruptions.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {machines.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold text-foreground">Machine breakdown</p>
              <select
                value={selectedMachine}
                onChange={(e) => setSelectedMachine(e.target.value)}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.status})</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={faultCode}
                  onChange={(e) => setFaultCode(e.target.value)}
                  placeholder="Fault code"
                  className="h-9 flex-1 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                />
                <input
                  type="number"
                  min={1}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Math.max(1, Number(e.target.value)))}
                  className="h-9 w-24 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                />
                <span className="flex items-center text-xs text-muted">min</span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={isPending || !selectedMachine}
                  onClick={() =>
                    run("Breakdown reported — reschedule triggered.", () =>
                      triggerMachineBreakdownAction(selectedMachine, faultCode, durationMinutes)
                    )
                  }
                >
                  Report breakdown
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isPending || !selectedMachine}
                  onClick={() => run("Machine marked available.", () => repairMachineAction(selectedMachine))}
                >
                  Mark repaired
                </Button>
              </div>
            </div>
          )}

          {orders.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold text-foreground">Order disruption</p>
              <select
                value={selectedOrder}
                onChange={(e) => {
                  setSelectedOrder(e.target.value);
                  const order = orders.find((o) => o.id === e.target.value);
                  if (order) setNewQuantity(order.quantity);
                }}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>{o.productSku} · qty {o.quantity} ({o.status})</option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={newQuantity}
                  onChange={(e) => setNewQuantity(Math.max(1, Number(e.target.value)))}
                  className="h-9 w-24 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isPending || !selectedOrder}
                  onClick={() =>
                    run("Order quantity updated — reschedule triggered.", () =>
                      changeOrderQuantityAction(selectedOrder, newQuantity)
                    )
                  }
                >
                  Change quantity
                </Button>
              </div>
              <Button
                variant="danger"
                size="sm"
                disabled={isPending || !selectedOrder}
                onClick={() => run("Order cancelled — reschedule triggered.", () => cancelOrderAction(selectedOrder))}
              >
                Cancel order
              </Button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {message && <p className="text-sm text-success">{message}</p>}
    </div>
  );
}
