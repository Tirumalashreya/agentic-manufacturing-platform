"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PricingModal } from "@/components/ui/PricingModal";

export function UpgradeSection() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <p className="text-sm font-semibold text-foreground">Change plan</p>
      <p className="mt-1 text-sm text-muted">Compare Starter, Pro, and Enterprise.</p>
      <Button className="mt-4" onClick={() => setOpen(true)}>
        View plans
      </Button>
      <PricingModal open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
