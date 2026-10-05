# app/security.py
"""
Auth/Authz hardening, Phase 1 (Findings 1.1/1.3): agent-orchestrator
previously had zero authentication on any route — every mutation endpoint
(pipeline runs, all four approval-resolve endpoints, billing mark-paid,
production complete, sales-order reschedule/simulate) was directly callable
by anyone who could reach the port.

Two, deliberately different, credentials are checked here, matching the
two real kinds of caller this service has:

- INTERNAL_SERVICE_TOKEN: the same shared secret every TS microservice now
  requires (see packages/shared/src/serviceAuth.ts) — used for real
  service-to-service calls (mes-integration -> this service's
  /production-orders/:id/complete).
- A forwarded end-user session: Ledger is the only real *user*-facing
  caller. Since Ledger has no session system of its own yet (Finding 1.6,
  addressed in this same phase), Ledger's own server-side proxy is what
  actually holds the session and forwards a verified user identity here as
  a header — this file trusts that header only when it also carries the
  internal service token, so a request can't forge the identity header
  without already possessing the shared secret.
"""
import os

from fastapi import Depends, Header, HTTPException

INTERNAL_HEADER = "x-internal-token"
USER_HEADER = "x-forwarded-user"
ROLE_HEADER = "x-forwarded-role"

# Real roles this build actually has (packages/domain/prisma/schema.prisma's
# UserRole enum) — reused as-is, not reinvented, per the explicit "don't
# build a new RBAC system" instruction.
ROLE_RANK = {"VIEWER": 0, "PLANNER": 1, "ADMIN": 2, "OWNER": 3}


def _expected_token() -> str | None:
    return os.environ.get("INTERNAL_SERVICE_TOKEN")


def require_service_token(x_internal_token: str | None = Header(default=None, alias=INTERNAL_HEADER)) -> None:
    """Every route in this service requires this — see main.py's app-wide dependency."""
    expected = _expected_token()
    if not expected:
        # Fail closed: an unset token must never silently mean "no auth
        # required" — matches serviceAuth.ts's identical TS-side default.
        raise HTTPException(status_code=500, detail="Service misconfigured — internal auth token not set")
    if not x_internal_token:
        raise HTTPException(status_code=401, detail="Missing internal service credential")
    if x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Invalid internal service credential")


class ForwardedUser:
    def __init__(self, user_id: str, role: str):
        self.user_id = user_id
        self.role = role


def require_user(
    x_internal_token: str | None = Header(default=None, alias=INTERNAL_HEADER),
    x_forwarded_user: str | None = Header(default=None, alias=USER_HEADER),
    x_forwarded_role: str | None = Header(default=None, alias=ROLE_HEADER),
) -> ForwardedUser:
    """
    For the routes a real human approves/creates/pays from (approvals,
    pipeline runs, billing mark-paid) — requires BOTH the service token
    (proves the call came through Ledger's own authenticated proxy, not
    directly from a browser or a script) AND a forwarded user identity
    (proves a real logged-in session initiated it). Neither alone is
    sufficient: a bare service token would let any internal caller
    impersonate a user by just adding a header; a bare user header with no
    service token would let anyone claim to be any user.
    """
    require_service_token(x_internal_token)
    if not x_forwarded_user or not x_forwarded_role:
        raise HTTPException(status_code=401, detail="No authenticated user forwarded with this request")
    if x_forwarded_role not in ROLE_RANK:
        raise HTTPException(status_code=403, detail=f"Unknown role: {x_forwarded_role}")
    return ForwardedUser(user_id=x_forwarded_user, role=x_forwarded_role)


def require_role(minimum: str):
    """Dependency factory — e.g. Depends(require_role("PLANNER"))."""

    def dependency(user: ForwardedUser = Depends(require_user)) -> ForwardedUser:
        if ROLE_RANK[user.role] < ROLE_RANK[minimum]:
            raise HTTPException(status_code=403, detail=f"Requires {minimum} role or higher, has {user.role}")
        return user

    return dependency
