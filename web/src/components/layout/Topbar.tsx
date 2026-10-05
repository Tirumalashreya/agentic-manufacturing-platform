"use client";

import { usePathname } from "next/navigation";
import { UpgradePill } from "@/components/layout/UpgradePill";
import { signOutAction } from "@/app/(app)/topbar-actions";

// Longest-prefix-first (agreed with the user) — real bug fix: this used to
// hardcode "Production Planning" on every page regardless of which one was
// actually open. "/production-planning" must be checked before "/production"
// would be (it isn't a prefix here, but the ordering convention still
// matters if a nested route is ever added under an existing one).
const PAGE_TITLES: { prefix: string; label: string }[] = [
  { prefix: "/dashboard", label: "Dashboard" },
  { prefix: "/production-planning", label: "Production Planning" },
  { prefix: "/planning", label: "Planning" },
  { prefix: "/orders", label: "Production Orders" },
  { prefix: "/schedule", label: "Schedule" },
  { prefix: "/recovery", label: "Recovery" },
  { prefix: "/machines", label: "Machines" },
  { prefix: "/operators", label: "Operators" },
  { prefix: "/materials", label: "Materials" },
  { prefix: "/my-jobs", label: "My Jobs" },
  { prefix: "/calendar", label: "Calendar" },
  { prefix: "/import", label: "Import" },
  { prefix: "/settings", label: "Settings" },
];

function pageTitleFor(pathname: string): string {
  const match = PAGE_TITLES.find((p) => pathname.startsWith(p.prefix));
  return match?.label ?? "APS Platform";
}

export function Topbar({
  email,
  tier,
}: {
  email: string;
  tier: string;
}) {
  const pathname = usePathname();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <div className="text-sm font-medium text-foreground">{pageTitleFor(pathname)}</div>
      <div className="flex items-center gap-4">
        {tier === "STARTER" && <UpgradePill />}
        <span className="text-sm text-muted">{email}</span>
        <form action={signOutAction}>
          <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
