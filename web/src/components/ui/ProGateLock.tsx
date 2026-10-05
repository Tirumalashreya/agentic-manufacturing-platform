"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PricingModal } from "@/components/ui/PricingModal";

export function ProGateLock({
  feature,
  children,
}: {
  feature: string;
  children: React.ReactNode;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none blur-sm">
        {children}
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-surface/80 p-4 text-center">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock size={16} />
          Pro only — {feature}
        </div>
        <Button size="sm" onClick={() => setModalOpen(true)}>
          See Pro features →
        </Button>
      </div>
      <PricingModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
