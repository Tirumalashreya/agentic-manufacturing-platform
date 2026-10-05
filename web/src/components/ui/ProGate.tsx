import { auth } from "@/lib/auth";
import { ProGateLock } from "@/components/ui/ProGateLock";

// Server component: reads the tenant's real tier from the session (auth.ts
// looks it up live from Postgres) and either renders the gated feature or a
// locked placeholder. PricingModal (client component) lives inside
// ProGateLock since opening it requires client-side state.
export async function ProGate({
  feature,
  children,
}: {
  feature: string;
  children: React.ReactNode;
}) {
  const session = await auth();
  const tier = session?.user.tier ?? "STARTER";

  if (tier === "PRO" || tier === "ENTERPRISE") {
    return <>{children}</>;
  }

  return <ProGateLock feature={feature}>{children}</ProGateLock>;
}
