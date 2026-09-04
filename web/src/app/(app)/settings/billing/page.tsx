import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { UpgradeSection } from "@/components/billing/UpgradeSection";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage() {
  const session = await auth();
  const enterprise = session?.user.enterpriseId
    ? await prisma.enterprise.findUnique({ where: { id: session.user.enterpriseId } })
    : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-foreground">Billing</h1>

      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Current plan</p>
            <p className="mt-1 text-lg font-semibold text-foreground">{enterprise?.tier ?? "STARTER"}</p>
          </div>
          <Badge>{enterprise?.tier ?? "STARTER"}</Badge>
        </div>
        {enterprise?.trialEndsAt && new Date(enterprise.trialEndsAt) > new Date() && (
          <p className="mt-2 text-sm text-muted">
            Trial ends {new Date(enterprise.trialEndsAt).toLocaleDateString()}
          </p>
        )}
        <p className="mt-4 text-xs text-muted">
          Billing is mocked in this environment — no payment processor is connected. Upgrading
          below just updates your organization's tier directly.
        </p>
      </Card>

      <UpgradeSection />
    </div>
  );
}
