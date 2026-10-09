#!/usr/bin/env bash
# Stage 07 (Backup / Recovery) — the restore half of backup-postgres.sh.
# Deliberately restores into a NEW, separate database by default (never
# the live one implicitly) — a disaster-recovery restore is a real,
# deliberate decision an operator makes explicitly, not something this
# script should make easy to point at production by accident. Pass the
# target database name as the second argument to restore somewhere else
# (e.g. the real target during an actual recovery, once the operator has
# confirmed that's genuinely what they want).
#
# Usage: infra/scripts/restore-postgres.sh <dump-file> [target-db-name]
set -euo pipefail

DUMP_FILE="${1:?Usage: restore-postgres.sh <dump-file> [target-db-name]}"
TARGET_DB="${2:-aps_platform_restore_test}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set — refusing to guess which Postgres server to restore into." >&2
  exit 1
fi
if [ ! -f "$DUMP_FILE" ]; then
  echo "Dump file not found: $DUMP_FILE" >&2
  exit 1
fi

CONN="${DATABASE_URL%%\?*}"
# Reuse the same host/port/user/password, swapping only the database name.
# CREATE/DROP DATABASE issued via psql against the server's own
# "postgres" maintenance database — more portable across psql/createdb
# version mismatches than relying on createdb/dropdb to parse a URI the
# same way psql does.
BASE_CONN="${CONN%/*}"

echo "Restoring $DUMP_FILE into a fresh database '$TARGET_DB' (never the live one implicitly)..."
psql "$BASE_CONN/postgres" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
psql "$BASE_CONN/postgres" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\";"
pg_restore --no-owner --no-privileges --dbname="$BASE_CONN/$TARGET_DB" "$DUMP_FILE"

echo "Restore complete into '$TARGET_DB'. Verifying row counts against a few known tables..."
psql "$BASE_CONN/$TARGET_DB" -c "
  SELECT 'Enterprise' AS table_name, count(*) FROM \"Enterprise\"
  UNION ALL SELECT 'SalesOrder', count(*) FROM \"SalesOrder\"
  UNION ALL SELECT 'ProductionOrder', count(*) FROM \"ProductionOrder\"
  UNION ALL SELECT 'ScheduledOperation', count(*) FROM \"ScheduledOperation\"
  UNION ALL SELECT 'AgentPipelineRun', count(*) FROM \"AgentPipelineRun\";
"

echo "Restore verification complete. Drop '$TARGET_DB' when done inspecting it: dropdb \"$TARGET_DB\""
