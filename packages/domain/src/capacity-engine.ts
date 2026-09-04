import type { Redis } from "ioredis";

// §8 Capacity Bucket Model: "Time is modelled as 15-minute capacity buckets
// per machine across 13 weeks... stored as Redis sorted sets (O(log N)
// insert, O(log N+K) range query) and persisted to PostgreSQL."
//
// Concretely: a Redis Hash per bucket holds the actual fields (total/used/
// reserved/available capacity, blocking reason), and a per-machine Sorted
// Set indexes bucket start-times so a time-range query is the promised
// O(log N + K) ZRANGEBYSCORE rather than a full scan. Persistence to
// Postgres happens at the ScheduledOperation/ResourceReservation layer
// (scheduling-service), not duplicated here.

export const BUCKET_MINUTES = 15;
const WEEK_MINUTES = 7 * 24 * 60;
export const HORIZON_WEEKS = 13;

export type CapacityBucket = {
  bucketStart: number; // epoch minutes, floor to BUCKET_MINUTES
  totalCapacity: number; // minutes of usable machine time in this bucket
  usedCapacity: number;
  reservedCapacity: number;
  blockingReason: string | null;
};

function bucketStartMinutes(date: Date): number {
  const epochMin = Math.floor(date.getTime() / 60_000);
  return epochMin - (epochMin % BUCKET_MINUTES);
}

// `namespace` defaults to "" (real capacity, unchanged for every existing
// caller). What-If simulation (scheduling-service) passes a scratch
// namespace so it can copy real capacity into an isolated key space, layer a
// hypothetical adjustment on top, and run genuine capacity-aware scheduling
// against it without ever touching the real buckets these default-namespace
// keys point at.
function hashKey(machineId: string, bucketStart: number, namespace = ""): string {
  return `cap:${namespace ? `${namespace}:` : ""}${machineId}:${bucketStart}`;
}

function indexKey(machineId: string, namespace = ""): string {
  return `cap:idx:${namespace ? `${namespace}:` : ""}${machineId}`;
}

// effective_capacity = (shift_min − break_min − maintenance_min) ×
// efficiency_factor × availability_factor
export function computeEffectiveCapacity(input: {
  shiftMin: number;
  breakMin: number;
  maintenanceMin: number;
  efficiencyFactor: number;
  availabilityFactor: number;
}): number {
  return (
    (input.shiftMin - input.breakMin - input.maintenanceMin) *
    input.efficiencyFactor *
    input.availabilityFactor
  );
}

export async function initBucket(
  redis: Redis,
  machineId: string,
  date: Date,
  totalCapacityMinutes: number,
  namespace = ""
): Promise<void> {
  const bucketStart = bucketStartMinutes(date);
  const key = hashKey(machineId, bucketStart, namespace);
  await redis.hset(key, {
    totalCapacity: totalCapacityMinutes,
    usedCapacity: 0,
    reservedCapacity: 0,
    blockingReason: "",
  });
  await redis.zadd(indexKey(machineId, namespace), bucketStart, String(bucketStart));
}

// What-If simulation seeding: copies one real bucket's exact state (total/
// used/reserved capacity, blocking reason) into a scratch namespace, so a
// dry run starts from the real current schedule's load instead of a blank
// slate — a hypothetical run over an unrealistically empty machine would be
// meaningless. No-op if there's no real bucket to copy (nothing has ever
// touched that time slot — safe to leave for the caller to init fresh/open,
// same as the real pipeline would) or the scratch bucket is already seeded
// (idempotent across repeated calls within the same dry run).
export async function seedNamespaceFromReal(redis: Redis, machineId: string, date: Date, namespace: string): Promise<void> {
  if (!namespace) return; // seeding "" onto itself would be a caller bug
  const alreadySeeded = await getBucket(redis, machineId, date, namespace);
  if (alreadySeeded) return;
  const real = await getBucket(redis, machineId, date, "");
  if (!real) return;

  const bucketStart = bucketStartMinutes(date);
  await redis.hset(hashKey(machineId, bucketStart, namespace), {
    totalCapacity: real.totalCapacity,
    usedCapacity: real.usedCapacity,
    reservedCapacity: real.reservedCapacity,
    blockingReason: real.blockingReason ?? "",
  });
  await redis.zadd(indexKey(machineId, namespace), bucketStart, String(bucketStart));
}

export async function getBucket(redis: Redis, machineId: string, date: Date, namespace = ""): Promise<CapacityBucket | null> {
  const bucketStart = bucketStartMinutes(date);
  const raw = await redis.hgetall(hashKey(machineId, bucketStart, namespace));
  if (!raw || Object.keys(raw).length === 0) return null;
  return {
    bucketStart,
    totalCapacity: Number(raw.totalCapacity),
    usedCapacity: Number(raw.usedCapacity),
    reservedCapacity: Number(raw.reservedCapacity),
    blockingReason: raw.blockingReason || null,
  };
}

function availableCapacity(bucket: CapacityBucket): number {
  return bucket.totalCapacity - bucket.usedCapacity - bucket.reservedCapacity;
}

// getAvailableWindows(work_centre, min_duration, earliest_start, latest_end) → List
export async function getAvailableWindows(
  redis: Redis,
  machineId: string,
  minDurationMin: number,
  earliestStart: Date,
  latestEnd: Date,
  namespace = ""
): Promise<{ start: Date; end: Date }[]> {
  const startScore = bucketStartMinutes(earliestStart);
  const endScore = bucketStartMinutes(latestEnd);
  const bucketStarts = await redis.zrangebyscore(indexKey(machineId, namespace), startScore, endScore);
  // bucketStartMinutes FLOORS to the 15-minute grid, so startScore can sit
  // up to 14 minutes before the real earliestStart (e.g. 12:55 floors to
  // 12:45) — the exact, unfloored minute is the true floor a returned
  // window's start must never sit before, or a successor operation can end
  // up scheduled before its own predecessor really finishes.
  const earliestStartMin = earliestStart.getTime() / 60_000;

  const windows: { start: Date; end: Date }[] = [];
  let runStart: number | null = null;
  let previousBucketEnd: number | null = null;

  for (const bs of bucketStarts) {
    const bucketStart = Number(bs);
    const bucket = await getBucket(redis, machineId, new Date(bucketStart * 60_000), namespace);
    const isOpen = bucket != null && !bucket.blockingReason && availableCapacity(bucket) > 0;
    const isContiguous = previousBucketEnd === bucketStart;

    if (isOpen && isContiguous && runStart != null) {
      // extend current run
    } else if (isOpen) {
      if (runStart != null && previousBucketEnd != null) {
        pushIfLongEnough(windows, runStart, previousBucketEnd, minDurationMin, earliestStartMin);
      }
      runStart = bucketStart;
    } else {
      if (runStart != null && previousBucketEnd != null) {
        pushIfLongEnough(windows, runStart, previousBucketEnd, minDurationMin, earliestStartMin);
      }
      runStart = null;
    }
    previousBucketEnd = bucketStart + BUCKET_MINUTES;
  }
  if (runStart != null && previousBucketEnd != null) {
    pushIfLongEnough(windows, runStart, previousBucketEnd, minDurationMin, earliestStartMin);
  }
  return windows;
}

function pushIfLongEnough(
  windows: { start: Date; end: Date }[],
  runStartMin: number,
  runEndMin: number,
  minDurationMin: number,
  floorMin: number
) {
  const clampedStartMin = Math.max(runStartMin, floorMin);
  if (runEndMin - clampedStartMin >= minDurationMin) {
    windows.push({ start: new Date(clampedStartMin * 60_000), end: new Date(runEndMin * 60_000) });
  }
}

// Reserves capacity across every bucket a [start, end) window touches.
// Returns { feasible: false } without mutating anything if any touched
// bucket lacks room — this is what the Constraint Engine's "Machine
// Capacity" check (§7) calls into for a specific candidate slot.
export async function reserveCapacity(
  redis: Redis,
  machineId: string,
  window: { start: Date; end: Date },
  minutesNeeded: number,
  namespace = ""
): Promise<{ feasible: boolean; reason?: string }> {
  // Compare against the window's raw end time (not the end time floored to
  // a bucket boundary) — a window ending exactly on a boundary must not
  // pull in the next bucket, but a window ending mid-bucket must.
  const endMinutesRaw = window.end.getTime() / 60_000;
  const bucketStarts: number[] = [];
  for (let t = bucketStartMinutes(window.start); t < endMinutesRaw; t += BUCKET_MINUTES) {
    bucketStarts.push(t);
  }

  for (const bs of bucketStarts) {
    const bucket = await getBucket(redis, machineId, new Date(bs * 60_000), namespace);
    if (!bucket) return { feasible: false, reason: `No capacity bucket initialized at ${new Date(bs * 60_000).toISOString()}` };
    if (bucket.blockingReason) return { feasible: false, reason: bucket.blockingReason };
    if (availableCapacity(bucket) < Math.min(BUCKET_MINUTES, minutesNeeded)) {
      return { feasible: false, reason: "Insufficient capacity in bucket " + bs };
    }
  }

  for (const bs of bucketStarts) {
    await redis.hincrby(hashKey(machineId, bs, namespace), "reservedCapacity", Math.min(BUCKET_MINUTES, minutesNeeded));
  }
  return { feasible: true };
}

// §7 "Machine Downtime/Breakdown" and "Preventive Maintenance" constraints:
// "PM windows are BLOCKED reservations" — marks every bucket a [start, end)
// window touches with blockingReason, so getAvailableWindows/reserveCapacity
// (which already check this field) actually treat the slot as unavailable.
// Previously nothing ever called this — maintenance orders were recorded in
// Postgres but never blocked real capacity, a gap caught during review.
export async function blockCapacity(
  redis: Redis,
  machineId: string,
  window: { start: Date; end: Date },
  reason: string,
  namespace = ""
): Promise<void> {
  const endMinutesRaw = window.end.getTime() / 60_000;
  for (let t = bucketStartMinutes(window.start); t < endMinutesRaw; t += BUCKET_MINUTES) {
    const bucketDate = new Date(t * 60_000);
    const existing = await getBucket(redis, machineId, bucketDate, namespace);
    if (!existing) await initBucket(redis, machineId, bucketDate, 0, namespace);
    await redis.hset(hashKey(machineId, t, namespace), "blockingReason", reason);
  }
}

// Reverses blockCapacity — a machine repaired earlier than its breakdown's
// original estimated duration needs its remaining blocked buckets reopened
// immediately (a real "back online now" signal shouldn't wait for a
// duration estimate to elapse). Clearing blockingReason on a bucket that
// was never blocked is a harmless no-op (empty string either way), so this
// is safe to call broadly across the whole capacity horizon rather than
// needing to know exactly which buckets were blocked.
export async function unblockCapacity(
  redis: Redis,
  machineId: string,
  window: { start: Date; end: Date },
  namespace = ""
): Promise<void> {
  const endMinutesRaw = window.end.getTime() / 60_000;
  for (let t = bucketStartMinutes(window.start); t < endMinutesRaw; t += BUCKET_MINUTES) {
    const existing = await getBucket(redis, machineId, new Date(t * 60_000), namespace);
    if (existing) await redis.hset(hashKey(machineId, t, namespace), "blockingReason", "");
  }
}

// Counterpart to reserveCapacity — releases exactly the minutes a prior
// reservation held, for a window that's being deleted/replaced (a real gap
// found while building the planning time fence: every scheduling rerun was
// creating fresh reservations without ever releasing the previous run's,
// so reservedCapacity silently grew forever across repeated runs even
// though the real plan wasn't actually getting any bigger). Floors at 0 so
// a mismatched/duplicate release call can't push a bucket negative.
export async function releaseCapacity(
  redis: Redis,
  machineId: string,
  window: { start: Date; end: Date },
  minutesReserved: number,
  namespace = ""
): Promise<void> {
  const endMinutesRaw = window.end.getTime() / 60_000;
  for (let t = bucketStartMinutes(window.start); t < endMinutesRaw; t += BUCKET_MINUTES) {
    const bucket = await getBucket(redis, machineId, new Date(t * 60_000), namespace);
    if (!bucket) continue;
    const amount = Math.min(BUCKET_MINUTES, minutesReserved);
    const newReserved = Math.max(0, bucket.reservedCapacity - amount);
    await redis.hset(hashKey(machineId, t, namespace), "reservedCapacity", newReserved);
  }
}

// load_pct(WC, week) = Σ(scheduled_op_hours) / Σ(available_capacity_hours) × 100
export async function computeLoadPct(redis: Redis, machineId: string, weekStart: Date): Promise<number> {
  const startScore = bucketStartMinutes(weekStart);
  const endScore = startScore + WEEK_MINUTES;
  const bucketStarts = await redis.zrangebyscore(indexKey(machineId), startScore, endScore - 1);

  let usedTotal = 0;
  let capacityTotal = 0;
  for (const bs of bucketStarts) {
    const bucket = await getBucket(redis, machineId, new Date(Number(bs) * 60_000));
    if (!bucket) continue;
    usedTotal += bucket.usedCapacity + bucket.reservedCapacity;
    capacityTotal += bucket.totalCapacity;
  }
  if (capacityTotal === 0) return 0;
  return (usedTotal / capacityTotal) * 100;
}

export const OVERLOAD_THRESHOLD_PCT = 90;

export function isOverloaded(loadPct: number, threshold = OVERLOAD_THRESHOLD_PCT): boolean {
  return loadPct > threshold;
}
