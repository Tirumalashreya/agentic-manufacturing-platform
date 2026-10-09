import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { TrialBanner } from "@/components/layout/TrialBanner";
import { LiveConnectivityBanner } from "@/components/LiveConnectivityBanner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const enterprise = session?.user.enterpriseId
    ? await prisma.enterprise.findUnique({ where: { id: session.user.enterpriseId } })
    : null;

  // enterprise is fetched fresh above, so its tier/trialEndsAt are used
  // directly here rather than session.user's copies — the session's copy of
  // these fields round-trips through NextAuth's JWT cookie, which silently
  // turns trialEndsAt into a string on the way back out even though the
  // Session type says Date (caught via a real TypeError during verification).
  const tier = enterprise?.tier ?? "STARTER";

  return (
    <div className="flex min-h-full">
      <Sidebar orgName={enterprise?.name ?? ""} tier={tier} />
      {/* Phase 18 (Frontend UX & Visual Polish) — real gap found: this
          flex child had no min-w-0, so a flex item's default min-width
          (auto, i.e. "as wide as my widest descendant needs") let a wide
          inner element (the Schedule page's Gantt chart) stretch this
          whole column — and the page itself — well past the viewport,
          confirmed live at a 390px width (document.scrollWidth: 1362).
          min-w-0 is the standard fix: it lets this column actually
          shrink to the space the sidebar leaves it, so an individual
          page's own overflow-x:auto container (MachineGanttChart already
          has one) is what scrolls, not the whole layout. */}
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <Topbar email={session?.user?.email ?? ""} tier={tier} />
        <LiveConnectivityBanner />
        <TrialBanner trialEndsAt={enterprise?.trialEndsAt?.toISOString() ?? null} />
        <main className="flex-1 overflow-y-auto px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
