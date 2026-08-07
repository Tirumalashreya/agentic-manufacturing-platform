import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Check, X } from "lucide-react";
import { auth } from "@/lib/auth";
import { Container } from "@/components/ui/Container";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PLANS } from "@/lib/plans";

export const metadata: Metadata = { title: "Finite-Capacity Production Scheduling" };

const FEATURES = [
  {
    title: "Constraint Engine",
    description: "16 hard/soft constraints — capacity, skills, tooling, calendars, QC holds — checked before every assignment.",
  },
  {
    title: "Capacity Planning",
    description: "15-minute capacity buckets per machine, real-time load %, automatic bottleneck detection.",
  },
  {
    title: "Forward + Backward Scheduling",
    description: "Schedule earliest-feasible-forward for new orders, or work backward from a due date for deadline-critical jobs.",
  },
  {
    title: "CP-SAT Optimization",
    description: "A real Google OR-Tools constraint-programming solver minimizes changeover, idle time, and delays.",
  },
  {
    title: "Conflict-Free by Construction",
    description: "A database exclusion constraint guarantees no two committed reservations ever overlap on the same resource.",
  },
  {
    title: "Production Analytics",
    description: "OEE, bottleneck index, on-time delivery, and scrap tracked continuously against the published schedule.",
  },
];

export default async function LandingPage() {
  // Logging in redirects to "/" by default (the login form's callbackUrl),
  // which is this public marketing page since the SaaS-wrapper change — a
  // real bug caught live: it looked like login silently failed. Send an
  // already-authenticated visitor straight into the app instead.
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <>
      <section
        className="border-b border-border py-24"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 70% 50% at 50% 0%, var(--brand-100), transparent)",
        }}
      >
        <Container className="flex flex-col items-center text-center">
          <Badge>Finite-Capacity Scheduling · No AI dependencies</Badge>
          <h1 className="mt-6 max-w-3xl text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl">
            Where your production schedule finally keeps up with the shop floor
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted">
            A real constraint-and-capacity scheduling engine for discrete manufacturers —
            machines, operators, tools, and materials, all planned together.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button href="/register" size="lg">
              Start free 14-day trial
            </Button>
            <Button href="#pricing" variant="secondary" size="lg">
              See pricing
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted">
            No credit card required · Cancel any time · Free on 1 plant
          </p>
        </Container>
      </section>

      <section id="features" className="py-20">
        <Container>
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-muted">Core engine</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
              Everything a planner needs, actually working
            </h2>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.title}>
                <h3 className="font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted">{feature.description}</p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      <section id="pricing" className="border-t border-border bg-surface py-20">
        <Container>
          <div className="text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-muted">Pricing</p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
              Simple, plant-based pricing
            </h2>
          </div>
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <Card
                key={plan.tier}
                className={plan.highlighted ? "border-brand-500 ring-1 ring-brand-500" : undefined}
              >
                {plan.highlighted && (
                  <Badge className="mb-3">Most popular</Badge>
                )}
                <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
                <p className="mt-1 text-2xl font-bold text-foreground">{plan.price}</p>
                <p className="mt-2 text-sm text-muted">{plan.description}</p>
                <Button href="/register" className="mt-6 w-full" variant={plan.highlighted ? "primary" : "secondary"}>
                  {plan.cta}
                </Button>
                <ul className="mt-6 flex flex-col gap-2 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature.label} className="flex items-center gap-2">
                      {feature.included ? (
                        <Check size={16} className="shrink-0 text-brand-600" />
                      ) : (
                        <X size={16} className="shrink-0 text-muted" />
                      )}
                      <span className={feature.included ? "text-foreground" : "text-muted"}>
                        {feature.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-brand-600 py-16">
        <Container className="flex flex-col items-center text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Ready to connect your production schedule?
          </h2>
          <Button href="/register" variant="onBrand" size="lg" className="mt-6">
            Start free 14-day trial
          </Button>
          <p className="mt-3 text-sm text-white/70">No credit card · 14 days · Cancel any time</p>
        </Container>
      </section>
    </>
  );
}
