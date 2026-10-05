// Plain SVG radial gauge — no chart library. Matches the BEAS-style
// "On time for shipping" / "Productivity" / "Scrap" dial widgets: a ring
// showing pct filled, colored by how good/bad the value is.
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
  const color = value == null ? "var(--muted)" : isGood ? "#22c55e" : isWarn ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="var(--border)"
          strokeWidth={STROKE}
        />
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
          className="transition-[stroke-dashoffset] duration-500 ease-out"
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-foreground text-lg font-bold"
        >
          {value == null ? "—" : `${value.toFixed(1)}%`}
        </text>
      </svg>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}
