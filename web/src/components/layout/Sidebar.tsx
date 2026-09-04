import Link from "next/link";
import { LayoutDashboard, ClipboardList, CalendarClock, Gauge as GaugeIcon, Settings, Upload, Users, ListChecks, Cog, CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/production-planning", label: "Production Planning", icon: GaugeIcon },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/schedule", label: "Schedule", icon: CalendarClock },
  { href: "/machines", label: "Machines", icon: Cog },
  { href: "/operators", label: "Operators", icon: Users },
  { href: "/my-jobs", label: "My Jobs", icon: ListChecks },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/settings/billing", label: "Settings", icon: Settings },
];

export function Sidebar({ orgName, tier }: { orgName: string; tier: string }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex flex-col gap-1 border-b border-border px-4 py-4">
        <span className="text-sm font-bold tracking-tight text-foreground">APS Platform</span>
        <div className="flex items-center gap-2">
          <span className="truncate text-xs text-muted">{orgName}</span>
          <Badge className="px-1.5 py-0 text-[10px]">{tier}</Badge>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3 text-sm">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 font-medium text-muted transition-colors duration-100 hover:bg-surface-muted hover:text-foreground"
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
