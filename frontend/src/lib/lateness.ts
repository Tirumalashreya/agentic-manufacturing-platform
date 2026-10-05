// Ported from web/src/lib/lateness.ts verbatim (pure, no styling to port).
export type LatenessStatus = "LATE" | "AT_RISK" | "ON_TRACK" | "NO_DUE_DATE";

const AT_RISK_BUFFER_HOURS = 24;

export function computeLatenessStatus(scheduledEnd: Date, dueDate: Date | null, actualEnd?: Date | null): LatenessStatus {
  if (!dueDate) return "NO_DUE_DATE";
  const effectiveEnd = actualEnd ?? scheduledEnd;
  if (effectiveEnd.getTime() > dueDate.getTime()) return "LATE";
  const bufferMs = AT_RISK_BUFFER_HOURS * 60 * 60 * 1000;
  if (dueDate.getTime() - effectiveEnd.getTime() <= bufferMs) return "AT_RISK";
  return "ON_TRACK";
}
