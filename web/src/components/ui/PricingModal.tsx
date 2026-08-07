"use client";

import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PLANS } from "@/lib/plans";
import { upgradeTierAction } from "@/app/(app)/actions";

export function PricingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [pendingTier, setPendingTier] = useState<string | null>(null);

  function handleUpgrade(tier: "STARTER" | "PRO" | "ENTERPRISE") {
    setPendingTier(tier);
    startTransition(async () => {
      await upgradeTierAction(tier);
      onClose();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Upgrade your plan" className="max-w-4xl">
      <h2 className="text-xl font-semibold text-foreground">Upgrade your plan</h2>
      <p className="mt-1 text-sm text-muted">
        Mocked billing — no payment processor is wired up. Upgrading just flips your
        organization's tier immediately.
      </p>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <Card
            key={plan.tier}
            className={plan.highlighted ? "border-brand-500 ring-1 ring-brand-500" : undefined}
          >
            {plan.highlighted && <Badge className="mb-3">Most popular</Badge>}
            <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
            <p className="mt-1 text-2xl font-bold text-foreground">{plan.price}</p>
            <p className="mt-2 text-sm text-muted">{plan.description}</p>
            <Button
              onClick={() => handleUpgrade(plan.tier)}
              disabled={isPending}
              className="mt-6 w-full"
              variant={plan.highlighted ? "primary" : "secondary"}
            >
              {isPending && pendingTier === plan.tier ? "Upgrading…" : plan.cta}
            </Button>
            <ul className="mt-6 flex flex-col gap-2 text-sm">
              {plan.features.map((feature) => (
                <li key={feature.label} className="flex items-center gap-2">
                  {feature.included ? (
                    <Check size={16} className="shrink-0 text-brand-600" />
                  ) : (
                    <X size={16} className="shrink-0 text-muted" />
                  )}
                  <span className={feature.included ? "text-foreground" : "text-muted"}>
                    {feature.label}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Modal>
  );
}
