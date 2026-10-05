export type LatenessStatus = "LATE" | "AT_RISK" | "ON_TRACK" | "NO_DUE_DATE";

// Starting heuristic, tunable: an operation finishing within this many hours
// of its order's due date (but not yet past it) counts as at risk rather
// than safely on track.
const AT_RISK_BUFFER_HOURS = 24;

// Once an operation actually has a real completion time (actualEnd), that's
// the true answer to "will this be late" — not the original scheduled
// estimate, which a real completion can differ from in either direction.
export function computeLatenessStatus(scheduledEnd: Date, dueDate: Date | null, actualEnd?: Date | null): LatenessStatus {
  if (!dueDate) return "NO_DUE_DATE";
  const effectiveEnd = actualEnd ?? scheduledEnd;
  if (effectiveEnd.getTime() > dueDate.getTime()) return "LATE";
  const bufferMs = AT_RISK_BUFFER_HOURS * 60 * 60 * 1000;
  if (dueDate.getTime() - effectiveEnd.getTime() <= bufferMs) return "AT_RISK";
  return "ON_TRACK";
}
