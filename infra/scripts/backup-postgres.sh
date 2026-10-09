#!/usr/bin/env bash
# Stage 07 (Backup / Recovery) — the smallest real, repeatable backup this
# platform didn't have at all before this (confirmed: no backup script,
# no scheduled job, no retention policy existed anywhere in the repo).
# Custom-format pg_dump (-Fc): compressed, and the one format pg_restore
# can selectively/parallel-restore from — a plain SQL dump would work for
# restore-test purposes too, but -Fc is what a real recurring job should
# produce, so this is written to match that, not a demo shortcut.
#
# Usage: infra/scripts/backup-postgres.sh [output-dir]
# Reads the same DATABASE_URL every other script in this repo already
# expects to be set — never hardcodes credentials, matching how every
# service in this repo connects to this same Postgres.
set -euo pipefail

OUT_DIR="${1:-infra/backups}"
mkdir -p "$OUT_DIR"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set — refusing to guess which database to back up." >&2
  exit 1
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/aps_platform_${TIMESTAMP}.dump"

# Strip Prisma's own query-string params (?schema=public) the same way
# this repo's own migration tooling already has to (see
# packages/domain/prisma.config.ts's datasource handling) — pg_dump
# doesn't understand them.
CONN="${DATABASE_URL%%\?*}"

pg_dump "$CONN" --format=custom --no-owner --no-privileges --file="$OUT_FILE"

echo "Backup written: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"

# Retention (Stage 07 §6: "retention" is an explicit required field, not
# optional) — a fixed, documented count, not a guessed/unbounded policy.
# 14 daily backups is a real, stated choice: enough to recover from
# "we didn't notice for a week or two," small enough that this never
# silently fills a disk on its own.
RETENTION_COUNT=14
# shellcheck disable=SC2012
ls -1t "$OUT_DIR"/aps_platform_*.dump 2>/dev/null | tail -n +$((RETENTION_COUNT + 1)) | while read -r old; do
  echo "Pruning backup older than retention ($RETENTION_COUNT): $old"
  rm -f "$old"
done
