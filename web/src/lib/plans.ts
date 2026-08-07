// Shared plan data — used by the landing page pricing section and
// PricingModal so the two never drift out of sync.
export const PLANS = [
  {
    tier: "STARTER" as const,
    name: "Starter",
    price: "Free",
    description: "Try the full scheduling engine on one plant.",
    cta: "Start free trial",
    features: [
      { label: "1 plant", included: true },
      { label: "Forward scheduling", included: true },
      { label: "Constraint + capacity engine", included: true },
      { label: "Backward scheduling", included: false },
      { label: "CP-SAT optimization", included: false },
      { label: "Full KPI history", included: false },
    ],
  },
  {
    tier: "PRO" as const,
    name: "Pro",
    price: "$49/mo",
    description: "For teams running real production schedules.",
    cta: "Upgrade to Pro",
    highlighted: true,
    features: [
      { label: "Unlimited plants", included: true },
      { label: "Forward + backward scheduling", included: true },
      { label: "Constraint + capacity engine", included: true },
      { label: "CP-SAT optimization", included: true },
      { label: "Full KPI history", included: true },
      { label: "SSO / SAML", included: false },
    ],
  },
  {
    tier: "ENTERPRISE" as const,
    name: "Enterprise",
    price: "Custom",
    description: "Multi-plant manufacturers with compliance needs.",
    cta: "Contact sales",
    features: [
      { label: "Everything in Pro", included: true },
      { label: "SSO / SAML", included: true },
      { label: "Dedicated support", included: true },
      { label: "SLA", included: true },
    ],
  },
];
