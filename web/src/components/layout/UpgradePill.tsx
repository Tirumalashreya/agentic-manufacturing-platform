"use client";

import { useState } from "react";
import { PricingModal } from "@/components/ui/PricingModal";

export function UpgradePill() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-gradient-to-r from-brand-500 to-brand-600 px-3 py-1 text-xs font-semibold text-white shadow-sm shadow-brand-500/30 transition-opacity hover:opacity-90"
      >
        Upgrade to Pro
      </button>
      <PricingModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
