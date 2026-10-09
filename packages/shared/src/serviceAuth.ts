import type { NextFunction, Request, Response } from "express";
import { verifyIdentityAssertion, IdentityAssertionError, type VerifiedIdentity } from "./identity";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireIdentity() once the x-identity-assertion header has
       * been cryptographically verified — never set from any unsigned
       * header, body field, or query parameter. Route handlers must use
       * req.identity.enterpriseId for all tenant scoping; req.body/
       * req.query enterpriseId-shaped fields are never trusted (Stage 02). */
      identity?: VerifiedIdentity;
    }
  }
}

// Deliberately NOT importing logger.ts here, even though every other
// module in this package does: logger.ts does real, Node-only,
// side-effecting file-system work at module-load time (mkdirSync into
// infra/logs), which is fine for the 16 plain-Node TS services this was
// built for, but breaks immediately if anything importing this module
// (like Next.js's Turbopack SSR bundle — Ledger and APS both call
// internalServiceHeaders() from their own server-side code) evaluates it
// in a context where that real path doesn't resolve. console.error is a
// deliberately plain fallback for this one rare warning line, not a
// downgrade of this package's real logging story.

// Auth/Authz hardening, Phase 1 (Finding 1.1) — every one of the 16 TS
// microservices previously had zero authentication: any request that could
// reach a service's port could mutate real orders/inventory/schedules.
// This is deliberately NOT per-user auth — these are internal services,
// only ever meant to be called by Ledger, APS, agent-orchestrator, or each
// other, never directly by a browser or an end user. One shared secret,
// checked on every request, is the smallest mechanism that actually closes
// the "directly reachable from the network" gap without inventing a
// service-mesh/mTLS/JWT system this codebase has no other infrastructure
// for. `/health` is intentionally exempted (checked before this middleware
// runs — see http.ts's createApp) so orchestration/monitoring can still
// probe liveness without a credential.
const HEADER = "x-internal-token";

function expectedToken(): string | undefined {
  return process.env.INTERNAL_SERVICE_TOKEN;
}

// Fail CLOSED, not open: a service that boots without the token configured
// rejects every request rather than silently running unauthenticated (the
// exact failure mode this fix exists to close). Logged once per process,
// not per-request, so a misconfigured deployment is loud in its own
// startup logs without spamming a log line on every rejected call.
let warnedMissingToken = false;

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const expected = expectedToken();
  if (!expected) {
    if (!warnedMissingToken) {
      console.error(
        "INTERNAL_SERVICE_TOKEN is not set — refusing all non-health requests until it is configured. " +
          "This is a fail-closed default, not a bug: an unset token must never mean 'no auth required'."
      );
      warnedMissingToken = true;
    }
    res.status(500).json({ error: "Service misconfigured — internal auth token not set" });
    return;
  }

  const provided = req.header(HEADER);
  if (!provided) {
    res.status(401).json({ error: "Missing internal service credential" });
    return;
  }
  if (provided !== expected) {
    res.status(403).json({ error: "Invalid internal service credential" });
    return;
  }
  next();
}

// Used by every internal caller (agent-orchestrator's TS-facing calls,
// APS's own server-side service.ts/apsAgent.ts calls, service-to-service
// calls like scheduling-service -> optimization-service) so the header
// name/value logic lives in exactly one place. Never sent to, or readable
// from, browser code — every call site using this is server-side only.
export function internalServiceHeaders(): Record<string, string> {
  const token = expectedToken();
  if (!token) {
    throw new Error("INTERNAL_SERVICE_TOKEN is not set — cannot call another internal service without it");
  }
  return { [HEADER]: token };
}

const IDENTITY_HEADER = "x-identity-assertion";

// Stage 02: replaces trusting x-forwarded-user/x-forwarded-role (or any
// client-supplied enterpriseId) outright. Mounted AFTER requireServiceToken
// so the service-to-service trust boundary is unchanged — this adds a
// SECOND, independent check on top of it: even a caller that holds the
// shared INTERNAL_SERVICE_TOKEN can no longer assert an arbitrary
// role/enterprise just by setting a header, because that header must now
// also carry a valid signature over those exact claims. Always rejects
// with 401 on any failure (missing/malformed/bad signature/expired/wrong
// audience) — this is authentication ("who is this"), never authorization
// ("can they do X") — route handlers decide that using req.identity.
export function requireIdentity(expectedAudience: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = expectedToken();
    if (!secret) {
      res.status(500).json({ error: "Service misconfigured — internal auth token not set" });
      return;
    }
    try {
      req.identity = verifyIdentityAssertion(req.header(IDENTITY_HEADER), secret, expectedAudience);
      next();
    } catch (err) {
      if (err instanceof IdentityAssertionError) {
        res.status(401).json({ error: err.message });
        return;
      }
      res.status(401).json({ error: "Invalid identity assertion" });
    }
  };
}
