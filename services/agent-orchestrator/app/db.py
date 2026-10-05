# app/db.py
import json
import os
import asyncpg

# Prisma's connection string includes ?schema=public, a Prisma-specific param
# asyncpg doesn't understand — strip any query string before connecting.
def _asyncpg_url() -> str:
    return os.environ["DATABASE_URL"].split("?")[0]


async def get_connection():
    return await asyncpg.connect(_asyncpg_url())


async def create_run() -> str:
    conn = await get_connection()
    try:
        row = await conn.fetchrow(
            'INSERT INTO "AgentPipelineRun" (id, status) VALUES (gen_random_uuid()::text, $1) RETURNING id',
            "RUNNING",
        )
        return row["id"]
    finally:
        await conn.close()


async def log_stage(run_id: str, stage: str, output: dict):
    conn = await get_connection()
    try:
        await conn.execute(
            'INSERT INTO "AgentStageResult" (id, "runId", stage, "agentOutput") '
            "VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb)",
            run_id,
            stage,
            json.dumps(output),
        )
    finally:
        await conn.close()


async def finish_run(run_id: str, status: str):
    conn = await get_connection()
    try:
        await conn.execute(
            'UPDATE "AgentPipelineRun" SET status = $1, "finishedAt" = now() WHERE id = $2',
            status,
            run_id,
        )
    finally:
        await conn.close()


# Read side for the Production Planning page's "Plan History" section (see
# app/routers/pipeline.py's new GET routes) — the write side above already
# existed; nothing until now ever read AgentPipelineRun/AgentStageResult
# back.
#
# A real bug found live (agreed with the user): this used to return every
# run that reached the composed-execution gate, MTS included — cluttering
# a page titled "Production Planning" with requests that never touched
# production at all. Filtered to only runs whose composed_execution stage
# actually carried a real production_plan. `->>'production_plan'` (not
# `->`) matters here: `->` returns the JSON literal `null` for an explicit
# null value, which Postgres's `IS NOT NULL` does NOT treat as SQL NULL —
# `->>` extracts as text instead, where an explicit JSON null really does
# come back as SQL NULL, and a real object comes back as its (non-null)
# text form.
async def list_runs(limit: int = 50) -> list[dict]:
    conn = await get_connection()
    try:
        rows = await conn.fetch(
            'SELECT r.id, r.status, r."currentStage", r."createdAt", r."finishedAt" '
            'FROM "AgentPipelineRun" r '
            'WHERE EXISTS ('
            '  SELECT 1 FROM "AgentStageResult" s '
            '  WHERE s."runId" = r.id AND s.stage = \'composed_execution\' '
            "    AND s.\"agentOutput\" -> 'pending_approval' -> 'preview' ->> 'production_plan' IS NOT NULL"
            ') '
            'ORDER BY r."createdAt" DESC LIMIT $1',
            limit,
        )
        return [dict(row) for row in rows]
    finally:
        await conn.close()


# Real gap found live: "New session" in Agent Console is a deliberate
# hard reset (clears the chat and its browser storage), and there was no
# way back into a run left sitting at the approval screen once that
# happened — the run itself was always safely logged here, stage by
# stage, but nothing ever read it back for this purpose. AgentPipelineRun
# itself gets marked COMPLETED the moment the graph finishes streaming
# regardless of whether it actually executed or just paused at a human
# gate (composed_execution_node returning is what ends the graph either
# way) — so "still awaiting a decision" has to be read off the
# composed_execution stage's own logged status, not the run's.
#
# Known, accepted limitation: this can't tell whether a listed run was
# since resolved by some OTHER means (retyping the same request fresh,
# for instance) — nothing ties an /approvals/sales-order/resolve call
# back to the run_id that produced its context. Approving a re-listed
# entry that was already actioned just creates a second real order, the
# same as retyping the prompt would — not a new risk, not silently
# swallowed either.
async def list_pending_approvals(limit: int = 20) -> list[dict]:
    """Real bug found live (agreed with the user): this used to derive
    "pending" from AgentStageResult's frozen composed_execution snapshot,
    which never changes once written — so a run stayed listed here forever
    even after it was approved, rejected, or consumed. Approval State
    hardening already made AgentPipelineRun.approvalStatus the one real,
    live source of truth (see claim_approval) for exactly this; this now
    reads that directly instead of re-deriving from a stale snapshot. Also
    closes a second, narrower gap the old query had: it was hardcoded to
    stage='composed_execution', so a RESCHEDULE_PRODUCTION approval (from
    reschedule_request_node, a different stage) never appeared here at all
    — approvalAction/approvalPayload cover both real gate types identically."""
    conn = await get_connection()
    try:
        rows = await conn.fetch(
            'SELECT id AS "runId", "createdAt", "approvalAction", "approvalPayload" '
            'FROM "AgentPipelineRun" '
            "WHERE \"approvalStatus\" = 'PENDING' AND \"approvalExpiresAt\" > now() "
            'ORDER BY "createdAt" DESC LIMIT $1',
            limit,
        )
        results = []
        for row in rows:
            payload = json.loads(row["approvalPayload"]) if row["approvalPayload"] else {}
            action = row["approvalAction"]
            if action == "RESCHEDULE_PRODUCTION":
                preview = {
                    "sales_order_id": payload.get("sales_order_id"),
                    "kind": payload.get("kind"),
                    "scope": payload.get("scope"),
                    "mode": payload.get("mode"),
                }
                response = (
                    f"Ready to {payload.get('kind')} {payload.get('sales_order_id')} — scope "
                    f"{payload.get('scope')}. Nothing has been changed yet — awaiting your approval."
                )
            else:
                preview = {
                    "customer_name": payload.get("customer_name"),
                    "product_name": payload.get("product_name"),
                    "quantity": payload.get("quantity"),
                    "unit_price": payload.get("price"),
                }
                response = None
            results.append({
                "run_id": row["runId"],
                "created_at": row["createdAt"].isoformat(),
                "pending_approval": {"action": action, "context": payload, "preview": preview},
                "response": response,
            })
        return results
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Approval State hardening (agreed with the user) — the durable,
# server-authoritative counterpart to the approval gate a run may pause at.
# Every write below is a single, unconditional-on-round-trip SQL statement
# with the real guard baked into its WHERE clause — the atomicity this
# needs (single-consumer claim, can't approve-after-consumed, etc.) comes
# from Postgres's own row-level locking on a plain UPDATE, not from
# application-level locking or a second lock table. Two concurrent
# processes racing the exact same UPDATE against the exact same row can
# never both see themselves as the one that matched the WHERE clause —
# that's guaranteed by MVCC, not something this code has to build itself.
# ---------------------------------------------------------------------------

APPROVAL_TTL_HOURS = 24  # matches the real existing UX: Agent Console's own
# "Pending decisions" panel already lets a run be resumed the next day (a
# real ~15-hour-old pending approval was observed live this session) — a
# short TTL would break that already-shipped behavior. 24h is long enough
# to cover "I'll review this tomorrow morning" without leaving an approval
# executable against day-old credit/inventory facts indefinitely.


async def save_pending_approval(run_id: str, action: str, payload: dict, requested_by: str | None) -> None:
    """Called once, right after a run's graph execution ends paused at a
    real human-approval gate (see pipeline.py's start_run) — persists
    exactly what the human is being shown as the canonical, server-owned
    record of what this approval covers. Nothing about this write is
    conditional: a run reaches a gate at most once, so there's no race to
    guard here — the race starts at claim_approval below, once a decision
    is made."""
    conn = await get_connection()
    try:
        await conn.execute(
            'UPDATE "AgentPipelineRun" SET '
            '"approvalAction" = $2, "approvalStatus" = \'PENDING\', "approvalPayload" = $3::jsonb, '
            '"approvalExpiresAt" = now() + ($4 || \' hours\')::interval, "requestedBy" = $5 '
            "WHERE id = $1",
            run_id,
            action,
            json.dumps(payload),
            str(APPROVAL_TTL_HOURS),
            requested_by,
        )
    finally:
        await conn.close()


async def get_approval(run_id: str) -> dict | None:
    """Read-only — used both to build a real, specific error message when
    a claim fails (was it already resolved? expired? never existed?) and
    to hand the resolve endpoint its own server-stored payload to execute
    against, never the client's."""
    conn = await get_connection()
    try:
        row = await conn.fetchrow(
            'SELECT id, "approvalAction", "approvalStatus", "approvalPayload", "approvalExpiresAt", '
            '"requestedBy", "approvedAt", "approvedBy", "rejectedAt", "rejectedBy", "executedAt", "executionResult" '
            'FROM "AgentPipelineRun" WHERE id = $1',
            run_id,
        )
        if row is None:
            return None
        result = dict(row)
        if result["approvalPayload"] is not None:
            result["approvalPayload"] = json.loads(result["approvalPayload"])
        if result["executionResult"] is not None:
            result["executionResult"] = json.loads(result["executionResult"])
        return result
    finally:
        await conn.close()


async def claim_approval(run_id: str, expected_action: str, decision: str, actor_user_id: str) -> dict | None:
    """The one atomic operation this whole mechanism depends on. Two
    concurrent calls with the same run_id: at most one UPDATE actually
    matches a row (Postgres locks the row for the duration of the first
    UPDATE that reaches it; by the time the second one's WHERE clause is
    evaluated, approvalStatus is no longer 'PENDING', so it matches zero
    rows) — that single fact is what makes 'consumable exactly once' true
    without any extra locking. Returns the updated row on success, None on
    failure (already resolved, expired, or the wrong action type — the
    caller re-reads via get_approval to tell which, for an honest error
    message).

    expected_action is part of the SAME atomic WHERE clause, not a
    separate check run before or after the claim — a real bug found live
    while verifying this: checking the action only when the claim already
    failed left a window where /approvals/reschedule/resolve given a
    create_order run's id would still win the atomic claim (status really
    was PENDING) and burn a real approval executing the wrong code path
    entirely. Folding the action into the WHERE clause closes that: a
    mismatched action means zero rows match, full stop, same as an
    already-resolved or expired one.

    Expiry is checked and applied lazily, in the SAME statement, rather
    than needing a background sweep this codebase has no infrastructure
    for: a PENDING row whose approvalExpiresAt has passed is moved
    straight to EXPIRED instead of APPROVED/REJECTED, atomically, by the
    same UPDATE — a decision arriving one moment too late can never sneak
    through.
    """
    assert decision in ("APPROVED", "REJECTED")
    conn = await get_connection()
    try:
        # Expire first, in its own atomic statement — if this run's PENDING
        # window already passed, this flips it to EXPIRED regardless of
        # what decision is being attempted, so the decision UPDATE right
        # after this one will correctly match zero rows.
        await conn.execute(
            'UPDATE "AgentPipelineRun" SET "approvalStatus" = \'EXPIRED\' '
            "WHERE id = $1 AND \"approvalAction\" = $2 AND \"approvalStatus\" = 'PENDING' AND \"approvalExpiresAt\" < now()",
            run_id,
            expected_action,
        )

        if decision == "APPROVED":
            row = await conn.fetchrow(
                'UPDATE "AgentPipelineRun" SET '
                "\"approvalStatus\" = 'APPROVED', \"approvedAt\" = now(), \"approvedBy\" = $2 "
                "WHERE id = $1 AND \"approvalAction\" = $3 AND \"approvalStatus\" = 'PENDING' "
                'RETURNING id, "approvalAction", "approvalPayload"',
                run_id,
                actor_user_id,
                expected_action,
            )
        else:
            row = await conn.fetchrow(
                'UPDATE "AgentPipelineRun" SET '
                "\"approvalStatus\" = 'REJECTED', \"rejectedAt\" = now(), \"rejectedBy\" = $2 "
                "WHERE id = $1 AND \"approvalAction\" = $3 AND \"approvalStatus\" = 'PENDING' "
                'RETURNING id, "approvalAction", "approvalPayload"',
                run_id,
                actor_user_id,
                expected_action,
            )
        if row is None:
            return None
        result = dict(row)
        if result["approvalPayload"] is not None:
            result["approvalPayload"] = json.loads(result["approvalPayload"])
        return result
    finally:
        await conn.close()


async def mark_executed(run_id: str, result: dict) -> bool:
    """APPROVED -> CONSUMED, only once the real business mutation actually
    succeeded. Guarded the same way as claim_approval (WHERE approvalStatus
    = 'APPROVED'), so this can only ever fire once per approval even if
    called twice by mistake — not just relying on the caller's own control
    flow to only call it once."""
    conn = await get_connection()
    try:
        row = await conn.fetchrow(
            'UPDATE "AgentPipelineRun" SET '
            "\"approvalStatus\" = 'CONSUMED', \"executedAt\" = now(), \"executionResult\" = $2::jsonb "
            "WHERE id = $1 AND \"approvalStatus\" = 'APPROVED' "
            "RETURNING id",
            run_id,
            json.dumps(result),
        )
        return row is not None
    finally:
        await conn.close()


async def mark_execution_failed(run_id: str, error: dict) -> None:
    """Real mutation attempt failed after a successful claim — the
    approval stays APPROVED (not reverted to PENDING: re-attempting a
    request that failed on genuine bad input, e.g. an unresolvable
    customer/product, would fail identically, and reopening PENDING would
    reintroduce exactly the replay race this mechanism exists to close).
    The failure is recorded for the audit trail; a human needing to retry
    submits a fresh request, which is a new run with its own new approval,
    not a resurrection of this one. Best-effort: a logging failure here
    must never mask the real error already being returned to the caller."""
    conn = await get_connection()
    try:
        await conn.execute(
            'UPDATE "AgentPipelineRun" SET "executionResult" = $2::jsonb WHERE id = $1',
            run_id,
            json.dumps(error),
        )
    except Exception:
        pass
    finally:
        await conn.close()


async def get_run(run_id: str) -> dict | None:
    conn = await get_connection()
    try:
        run = await conn.fetchrow(
            'SELECT id, status, "currentStage", "createdAt", "finishedAt" '
            'FROM "AgentPipelineRun" WHERE id = $1',
            run_id,
        )
        if run is None:
            return None
        stage_rows = await conn.fetch(
            'SELECT id, stage, "agentOutput", "createdAt" '
            'FROM "AgentStageResult" WHERE "runId" = $1 ORDER BY "createdAt" ASC',
            run_id,
        )
        stages = []
        for row in stage_rows:
            stage = dict(row)
            stage["agentOutput"] = json.loads(stage["agentOutput"])
            stages.append(stage)
        return {**dict(run), "stages": stages}
    finally:
        await conn.close()
