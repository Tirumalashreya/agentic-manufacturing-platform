import Redis from "ioredis";

// Real ioredis client against the real local Redis (brew-installed, verified
// with PONG this session) — used for the Capacity Bucket Model (§8) sorted
// sets and distributed scheduling locks (§6 step 1).
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const LOCK_TTL_MS = 30_000;

// §6 step 1: "acquires Redis distributed lock for the plant". SET NX PX is
// the standard single-instance distributed-lock primitive — sufficient here
// since this is one Redis node, not the doc's 6-node cluster.
export async function acquirePlantLock(plantId: string): Promise<boolean> {
  const result = await redis.set(`lock:plant:${plantId}`, "1", "PX", LOCK_TTL_MS, "NX");
  return result === "OK";
}

export async function releasePlantLock(plantId: string): Promise<void> {
  await redis.del(`lock:plant:${plantId}`);
}
