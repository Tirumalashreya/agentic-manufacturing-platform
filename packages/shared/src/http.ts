// Express 4 does not forward a rejected promise from an async route handler
// to error-handling middleware — it's an unhandled rejection that crashes
// the whole process. Confirmed for real: a duplicate-SKU insert in
// routing-service's POST /products took the entire service down, not just
// that one request, during bulk-import verification. This patches Router
// methods so async handlers' rejections reach the error middleware below
// instead — must be imported before any app.get/post/etc. is registered.
import "express-async-errors";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { logger } from "./logger";
import { requireServiceToken } from "./serviceAuth";

// Stage 07 (Observability/Correlation) — the one real, end-to-end
// correlation identifier every workflow needs. Deliberately NOT a new
// column on every table, a new message broker, or a redesign of any
// call site: every request either carries the trace_id a caller already
// knows (agent-orchestrator's own run_id, once it starts one — see
// manufacturing_services.py's _internal_headers reading
// CURRENT_TRACE_ID), or — for the very first hop in a chain — gets a
// fresh one minted here, so nothing downstream is ever left with no
// trace_id to log or forward. TS augmentation lives here since this is
// the one place every service's Express app is actually constructed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traceId: string;
    }
  }
}
const TRACE_HEADER = "x-trace-id";

// Every service calls this instead of hand-rolling its own express() + JSON
// body-parsing + health check — keeps the 18 services consistent without a
// shared framework dependency beyond plain express.
//
// Auth/Authz hardening, Phase 1 (Finding 1.1): requireServiceToken is
// mounted here, AFTER /health, so every route any service registers next
// (its real, business-mutating routes) is protected by construction — a
// new service, or a new route on an existing one, gets this for free
// instead of needing to remember to add it. /health stays reachable
// without a credential (already registered above this line) so liveness
// probes/orchestration keep working.
// Phase 17 (Production Readiness & Observability) — real gap found: every
// one of the 18 services' /health was pure liveness ("the process is up"),
// with no way to tell a healthy-but-can't-reach-Postgres service apart
// from a genuinely healthy one. Optional and additive on purpose: every
// existing `createApp()` call site (16 of 18 services) passes nothing and
// is completely unaffected; a service only gets /health/ready once it
// opts in with a real check (order-service and scheduling-service do,
// via a Prisma `SELECT 1` — see their own app.ts/index.ts). Deliberately
// NOT folded into /health itself — an orchestrator's liveness probe
// (“should I restart this process”) and its readiness probe (“should I
// route traffic to it”) are different questions, and collapsing them
// would make a transient DB hiccup look like a crashed process.
export type CreateAppOptions = {
  readinessCheck?: () => Promise<boolean>;
};

export function createApp(options?: CreateAppOptions): Express {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    // Stage 07: echo an inbound trace_id (every internal caller that has
    // one — agent-orchestrator, or another TS service forwarding one it
    // received) or mint a fresh one for whatever's the true first hop
    // (a direct browser/API request). Set on req for every downstream
    // handler to read/forward, and echoed back on the response so a
    // caller that didn't send one can still pick it up for its own logs.
    req.traceId = req.header(TRACE_HEADER) || randomUUID();
    res.setHeader(TRACE_HEADER, req.traceId);
    logger.info(`${req.method} ${req.path}`, { traceId: req.traceId });
    next();
  });
  app.get("/health", (_req, res) => res.json({ status: "ok", service: process.env.SERVICE_NAME }));
  app.get("/health/ready", async (_req, res) => {
    if (!options?.readinessCheck) {
      // No dependency check configured for this service — still a
      // truthful answer (never fabricate a "ready" the service never
      // verified), not a 404 that looks like a missing route.
      res.json({ status: "ok", service: process.env.SERVICE_NAME, ready: true, checked: false });
      return;
    }
    try {
      const ready = await options.readinessCheck();
      res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "not_ready", service: process.env.SERVICE_NAME, ready, checked: true });
    } catch (error) {
      logger.error("Readiness check failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ status: "not_ready", service: process.env.SERVICE_NAME, ready: false, checked: true });
    }
  });
  app.use(requireServiceToken);
  return app;
}

export { TRACE_HEADER };

// Registered by each service after its routes (see individual index.ts
// files) — turns a thrown/rejected error into a clean JSON response instead
// of an unhandled-rejection crash. A Prisma unique-constraint violation
// (P2002) becomes a 409 with a readable message; everything else is a 500.
export function registerErrorHandler(app: Express): void {
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const prismaError = err as { code?: string; meta?: { target?: string[] } };
    if (prismaError.code === "P2002") {
      const fields = prismaError.meta?.target?.join(", ") ?? "field";
      res.status(409).json({ error: `A record with this ${fields} already exists` });
      return;
    }
    logger.error("Unhandled request error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  });
}
