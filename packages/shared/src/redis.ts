import Redis from "ioredis";
import { randomUUID } from "node:crypto";

// Real ioredis client against the real local Redis (brew-installed, verified
// with PONG this session) — used for the Capacity Bucket Model (§8) sorted
// sets and distributed scheduling locks (§6 step 1).
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const LOCK_TTL_MS = 30_000;
// Renew well before the TTL expires — a heartbeat this much slower than
// the TTL would risk missing a beat (a slow event-loop tick, a delayed
// setInterval firing) and losing the lock anyway; a third of the TTL
// gives real margin.
export const PLANT_LOCK_RENEWAL_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 3);

// §6 step 1: "acquires Redis distributed lock for the plant". SET NX PX is
// the standard single-instance distributed-lock primitive — sufficient here
// since this is one Redis node, not the doc's 6-node cluster.
//
// Real bug found live (agreed with the user): this used to be a bare
// SET NX PX with a fixed 30s TTL and NO renewal — a real scheduling run
// processing several open orders can legitimately take longer than 30s
// (each operation does multiple sequential Redis/Postgres round trips),
// and once the lock silently expired mid-run, a second, fully independent
// run could acquire it and start processing the SAME plant concurrently.
// Two genuinely concurrent runs racing on the same order (one mid-delete/
// re-create, the other reading a partial, in-flux row set) is exactly
// what produced real duplicate ScheduledOperation rows for whichever
// operation both runs happened to create — most likely under "multi-order
// commit run" scenarios specifically because those are the runs most
// likely to actually take longer than 30s.
//
// Fixed with a real token + heartbeat, the standard correct pattern for a
// lock protecting a variable-duration critical section: acquire returns a
// unique per-holder token (not just a boolean); the caller renews on a
// timer well inside the TTL for as long as the run is still in progress
// (see pipeline.ts's heartbeat); renew/release both check the token via
// an atomic Lua script before acting, so a run whose lock DID expire and
// got reacquired by someone else can never renew or release a lock it no
// longer actually holds — closing the second, related bug a token-less
// release would still have (deleting a lock a later run had legitimately
// acquired).
export async function acquirePlantLock(plantId: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(`lock:plant:${plantId}`, token, "PX", LOCK_TTL_MS, "NX");
  return result === "OK" ? token : null;
}

const _RENEW_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;
const _RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export async function renewPlantLock(plantId: string, token: string): Promise<boolean> {
  const result = await redis.eval(_RENEW_SCRIPT, 1, `lock:plant:${plantId}`, token, LOCK_TTL_MS);
  return result === 1;
}

export async function releasePlantLock(plantId: string, token: string): Promise<void> {
  await redis.eval(_RELEASE_SCRIPT, 1, `lock:plant:${plantId}`, token);
}
