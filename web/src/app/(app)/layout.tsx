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
      <div className="flex min-h-full flex-1 flex-col">
        <Topbar email={session?.user?.email ?? ""} tier={tier} />
        <LiveConnectivityBanner />
        <TrialBanner trialEndsAt={enterprise?.trialEndsAt?.toISOString() ?? null} />
        <main className="flex-1 overflow-y-auto px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
