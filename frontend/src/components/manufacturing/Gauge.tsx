// Plain SVG radial gauge — no chart library. Ported from
// web/src/components/ui/Gauge.tsx, restyled onto frontend's dark tokens.
const SIZE = 120;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function Gauge({
  label,
  value,
  goodDirection = "up",
}: {
  label: string;
  value: number | null;
  /** "up" = higher is better (on-time%, productivity%); "down" = lower is better (scrap%) */
  goodDirection?: "up" | "down";
}) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const offset = CIRCUMFERENCE * (1 - pct / 100);

  const isGood = goodDirection === "up" ? pct >= 90 : pct <= 10;
  const isWarn = goodDirection === "up" ? pct >= 70 : pct <= 25;
  const color = value == null ? "var(--text-faint)" : isGood ? "var(--money)" : isWarn ? "var(--gold)" : "var(--alert)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--line)" strokeWidth={STROKE} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ transition: "stroke-dashoffset 500ms ease-out" }}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fill="var(--text)" style={{ fontSize: 18, fontWeight: 700 }}>
          {value == null ? "—" : `${value.toFixed(1)}%`}
        </text>
      </svg>
      <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-soft)", margin: 0 }}>
        {label}
      </p>
    </div>
  );
}
