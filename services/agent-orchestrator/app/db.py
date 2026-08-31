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
