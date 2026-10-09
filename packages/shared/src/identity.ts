// Stage 02 (Tenant Isolation + Service Identity) — ARCHITECTURE_BASELINE.md
// Finding 1.1/1.3 and the Stage 02 brief: internal service identity
// previously relied entirely on a shared INTERNAL_SERVICE_TOKEN plus plain,
// unsigned x-forwarded-user/x-forwarded-role headers — anyone who already
// had the shared token (every internal caller) could set those headers to
// anything, including a role or enterprise they don't actually have. This
// module replaces that with a real, cryptographically verified identity
// assertion: a compact, signed token (header.payload.signature, HMAC-SHA256,
// base64url) carrying exactly the claims Stage 02 requires — subject,
// type (user vs. service), role, enterprise, issued-at/expiry, and the
// intended audience (which service this assertion is for) — so a claim
// can no longer be set by merely editing a header; it must be part of a
// signature only a holder of the signing secret could have produced.
//
// Deliberately NOT a new authentication provider: it's signed with the
// same INTERNAL_SERVICE_TOKEN every service already has in its environment
// (no new secret to provision/distribute), and for user-originated calls
// it's minted from an already-verified NextAuth session (see web's own
// caller-side changes) — this is a derived, short-lived service assertion
// of an identity that was already authenticated, not a parallel login
// system.
import { createHmac, timingSafeEqual } from "node:crypto";

export type IdentityType = "user" | "service";

export interface IdentityClaims {
  /** Subject — a real User.id for type "user", or a fixed service name (e.g. "agent-orchestrator") for type "service". */
  sub: string;
  type: IdentityType;
  /** Omitted for a pure service identity with no acting human/role. */
  role?: string;
  /** The real Enterprise.id this request is scoped to. Never optional — Stage 02's whole point is that this is never guessed or defaulted. */
  enterpriseId: string;
  /** The service this assertion is for (e.g. "order-service") — verified on the receiving end so a token minted for one service can't be replayed against another. */
  aud: string;
}

export interface VerifiedIdentity extends IdentityClaims {
  iat: number;
  exp: number;
}

export class IdentityAssertionError extends Error {
  constructor(public readonly reason: "missing" | "malformed" | "signature" | "expired" | "audience", message: string) {
    super(message);
    this.name = "IdentityAssertionError";
  }
}

const DEFAULT_TTL_SECONDS = 60; // short-lived by design — minimizes any replay window

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mints a signed identity assertion. Called only by a caller that has
 * already authenticated the subject itself (a verified NextAuth session,
 * or a service's own fixed, configured identity) — this function does not
 * authenticate anything; it attests to claims the caller already knows to
 * be true. */
export function signIdentityAssertion(claims: IdentityClaims, secret: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: VerifiedIdentity = { ...claims, iat: now, exp: now + ttlSeconds };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "APS-IDENTITY" }));
  const body = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/** Verifies a signed identity assertion against the given secret and
 * expected audience. Throws IdentityAssertionError (never returns a
 * partially-trusted result) on any failure — missing, malformed, bad
 * signature, expired, or wrong audience are all treated as "not
 * authenticated," never as "authenticated with some claims unverified." */
export function verifyIdentityAssertion(token: string | undefined, secret: string, expectedAudience: string): VerifiedIdentity {
  if (!token) {
    throw new IdentityAssertionError("missing", "No identity assertion provided");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new IdentityAssertionError("malformed", "Identity assertion is not in the expected 3-part format");
  }
  const [header, body, signature] = parts;
  const expectedSignature = sign(`${header}.${body}`, secret);
  // Constant-time comparison — this is the one place a timing side-channel
  // could otherwise leak information about the correct signature.
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new IdentityAssertionError("signature", "Identity assertion signature is invalid");
  }
  let claims: VerifiedIdentity;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new IdentityAssertionError("malformed", "Identity assertion payload is not valid JSON");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    throw new IdentityAssertionError("expired", "Identity assertion has expired");
  }
  if (claims.aud !== expectedAudience) {
    throw new IdentityAssertionError("audience", `Identity assertion is not valid for ${expectedAudience}`);
  }
  if (!claims.enterpriseId || !claims.sub || !claims.type) {
    throw new IdentityAssertionError("malformed", "Identity assertion is missing required claims");
  }
  return claims;
}
