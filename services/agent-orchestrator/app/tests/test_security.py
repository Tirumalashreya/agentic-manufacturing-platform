# app/tests/test_security.py
"""
Auth/Authz hardening, Phase 1 — focused tests for the security boundary
added this phase (app/security.py + main.py's app-wide dependency +
approvals.py/channels.py/sales_orders.py/pipeline.py's per-route role
gates). Proves, at the real HTTP boundary (via TestClient, not by calling
Python functions directly), exactly what the task asked for:

1. unauthenticated request -> rejected
2. authenticated (service token) but unauthorized (insufficient role) -> rejected
3. authorized (service token + sufficient role) -> succeeds
4. read-only access remains functional (service token alone is enough)
5. a mutation cannot be triggered by bypassing the frontend (no token at all,
   or a forged x-forwarded-role with no token, both fail)
"""
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-security-tests")

from app.main import app  # noqa: E402  (must import after setting the token above)

client = TestClient(app)
TOKEN = os.environ["INTERNAL_SERVICE_TOKEN"]


def test_read_route_rejects_missing_token():
    res = client.get("/pipeline/pending")
    assert res.status_code == 401


def test_read_route_rejects_wrong_token():
    res = client.get("/pipeline/pending", headers={"x-internal-token": "wrong"})
    assert res.status_code == 403


def test_read_route_succeeds_with_valid_token_alone():
    """Requirement 4: read-only access needs no forwarded user, just the
    service token — matches every GET route's actual dependency."""
    res = client.get("/pipeline/pending", headers={"x-internal-token": TOKEN})
    assert res.status_code == 200


def test_mutation_rejects_missing_everything():
    """Requirement 1/5: no token, no forwarded identity — the exact
    'call it directly, bypassing the frontend' scenario."""
    res = client.post("/approvals/sales-order/resolve", json={"context": {}, "decision": "REJECTED"})
    assert res.status_code == 401


def test_mutation_rejects_forged_role_header_without_token():
    """Requirement 5: a forged x-forwarded-role with no real service token
    must not be enough — proves identity can't be self-asserted."""
    res = client.post(
        "/approvals/sales-order/resolve",
        json={"context": {}, "decision": "REJECTED"},
        headers={"x-forwarded-user": "attacker", "x-forwarded-role": "OWNER"},
    )
    assert res.status_code == 401


def test_mutation_rejects_valid_token_but_no_user():
    """A valid service token alone is not sufficient for a route a human
    approves from — require_user additionally needs a forwarded identity."""
    res = client.post(
        "/approvals/sales-order/resolve",
        json={"context": {}, "decision": "REJECTED"},
        headers={"x-internal-token": TOKEN},
    )
    assert res.status_code == 401


def test_mutation_rejects_insufficient_role():
    """Requirement 2: authenticated (real token + real forwarded user) but
    unauthorized (VIEWER is below the PLANNER floor this route requires)."""
    res = client.post(
        "/approvals/sales-order/resolve",
        json={"context": {}, "decision": "REJECTED"},
        headers={"x-internal-token": TOKEN, "x-forwarded-user": "u1", "x-forwarded-role": "VIEWER"},
    )
    assert res.status_code == 403


@pytest.mark.parametrize("role", ["PLANNER", "ADMIN", "OWNER"])
def test_mutation_succeeds_for_planner_or_above(role):
    """Requirement 3: an authorized caller gets past the auth gate and into
    business logic. The endpoint now requires a real run_id bound to a
    PENDING approval (atomic claim), so a never-existed run_id is the
    no-side-effect way to prove authorization passed: the response is the
    business-layer 404 'No approval found', not a 401/403 auth rejection
    and not a 422 schema error."""
    res = client.post(
        "/approvals/sales-order/resolve",
        json={"run_id": f"security-test-nonexistent-{role}", "decision": "REJECTED"},
        headers={"x-internal-token": TOKEN, "x-forwarded-user": "u1", "x-forwarded-role": role},
    )
    assert res.status_code == 404
    assert "No approval found" in res.json()["detail"]


def test_unknown_role_is_rejected_not_silently_trusted():
    res = client.post(
        "/approvals/sales-order/resolve",
        json={"context": {}, "decision": "REJECTED"},
        headers={"x-internal-token": TOKEN, "x-forwarded-user": "u1", "x-forwarded-role": "SUPERADMIN"},
    )
    assert res.status_code == 403


def test_health_route_unaffected():
    """/health must stay reachable with no credential — orchestration/
    monitoring must not be broken by this hardening."""
    res = client.get("/health")
    assert res.status_code == 200
