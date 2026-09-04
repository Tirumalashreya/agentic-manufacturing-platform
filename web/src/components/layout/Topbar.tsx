import { signOut } from "@/lib/auth";
import { UpgradePill } from "@/components/layout/UpgradePill";

export function Topbar({
  email,
  tier,
}: {
  email: string;
  tier: string;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <div className="text-sm text-muted">Production Planning</div>
      <div className="flex items-center gap-4">
        {tier === "STARTER" && <UpgradePill />}
        <span className="text-sm text-muted">{email}</span>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
