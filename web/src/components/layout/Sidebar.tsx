import Link from "next/link";
import { LayoutDashboard, ClipboardList, CalendarClock, Gauge as GaugeIcon, Settings, Upload, Users, ListChecks, Cog, CalendarDays, Boxes, LineChart, LifeBuoy } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

// Grouped by manufacturing lifecycle stage (agreed with the user) — the
// flat 13-item list this replaces gave no visual cue that, say, Planning
// and Production Planning are upstream of Schedule, or that Recovery is a
// shop-floor concern, not a planning one. Same routes, same pages, purely
// a navigation regroup — no page moved or was created for this.
const NAV_GROUPS: { label: string | null; items: { href: string; label: string; icon: typeof LayoutDashboard }[] }[] = [
  { label: null, items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Demand & Planning",
    items: [
      { href: "/planning", label: "Planning", icon: LineChart },
      { href: "/production-planning", label: "Production Planning", icon: GaugeIcon },
    ],
  },
  {
    label: "Production",
    items: [
      { href: "/orders", label: "Orders", icon: ClipboardList },
      { href: "/schedule", label: "Schedule", icon: CalendarClock },
    ],
  },
  {
    label: "Shop Floor",
    items: [
      { href: "/my-jobs", label: "My Jobs", icon: ListChecks },
      { href: "/recovery", label: "Recovery", icon: LifeBuoy },
    ],
  },
  {
    label: "Materials",
    items: [{ href: "/materials", label: "Materials", icon: Boxes }],
  },
  {
    label: "Resources",
    items: [
      { href: "/machines", label: "Machines", icon: Cog },
      { href: "/operators", label: "Operators", icon: Users },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/import", label: "Import", icon: Upload },
      { href: "/settings/billing", label: "Settings", icon: Settings },
    ],
  },
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
      <nav className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 text-sm">
        {NAV_GROUPS.map((group, i) => (
          <div key={group.label ?? `group-${i}`} className="flex flex-col gap-1">
            {group.label && (
              <span className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                {group.label}
              </span>
            )}
            {group.items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 font-medium text-muted transition-colors duration-100 hover:bg-surface-muted hover:text-foreground"
              >
                <Icon size={16} />
                {label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
