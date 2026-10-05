"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

const DISMISS_KEY = "aps.trialBanner.dismissedAt";
const REAPPEAR_THRESHOLD_DAYS = 3;

export function TrialBanner({ trialEndsAt }: { trialEndsAt: string | null }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(true); // default hidden until localStorage check runs, avoids SSR/client flash

  const daysLeft = trialEndsAt
    ? Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000)
    : null;

  useEffect(() => {
    if (daysLeft == null || daysLeft <= 0) {
      setDismissed(true);
      return;
    }
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    // Dismissal only sticks while there's more than REAPPEAR_THRESHOLD_DAYS
    // left — once the trial gets urgent, show it again regardless.
    setDismissed(Boolean(dismissedAt) && daysLeft > REAPPEAR_THRESHOLD_DAYS);
  }, [daysLeft]);

  if (daysLeft == null || daysLeft <= 0 || dismissed) return null;

  const endDate = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";

  return (
    <div className="flex items-center justify-between gap-4 bg-brand-600 px-6 py-2 text-sm text-white">
      <span className={daysLeft === 1 ? "animate-pulse font-medium" : ""}>
        ⏱ {daysLeft} day{daysLeft === 1 ? "" : "s"} left on your free trial · Trial ends {endDate}
      </span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/settings/billing")}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          Upgrade now →
        </button>
        <button
          type="button"
          aria-label="Dismiss trial banner"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
            setDismissed(true);
          }}
          className="text-white/70 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
