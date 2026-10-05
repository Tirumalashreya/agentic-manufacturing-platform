import { Card } from "./Card";

// New — the Dashboard/Materials/etc. stat tiles are currently hand-built
// inline per page (design-system pass, agreed with the user). One real
// implementation, built on the existing Card primitive.
export function MetricCard({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <Card>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-foreground">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </Card>
  );
}
