import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Elasticsearch (§12) has no clean local install path on this machine (see
// build plan). This substitutes structured JSON-line logs — stdout plus a
// per-service file under infra/logs/ — which is what an ES ingest pipeline
// would consume anyway if one existed.
const LOG_DIR = path.resolve(__dirname, "../../../infra/logs");
// Auth/Authz hardening, Phase 1 — this file is written for the 16 plain-
// Node TS services, where __dirname always resolves to a real path. It's
// now also transitively imported (via this package's barrel export) by
// Ledger/APS's own Next.js server code, which pulled it in for the first
// time importing internalServiceHeaders (see serviceAuth.ts) — and
// Turbopack's SSR bundle context doesn't give __dirname a real filesystem
// path, so this crashed every page that imported anything from @aps/shared
// at all. Guarded rather than un-done: real services still get a real log
// directory; a context where that path is meaningless (this module still
// loads, just can't create the directory) degrades to console-only instead
// of crashing the importing application.
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // See comment above — non-fatal outside a real TS-service process.
}

const serviceName = process.env.SERVICE_NAME ?? "unknown-service";
const logFile = path.join(LOG_DIR, `${serviceName}.log`);

function write(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: serviceName,
    level,
    message,
    ...meta,
  });
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {
    // Same reasoning as the mkdirSync guard above — console.log already
    // happened either way, so nothing is silently lost, just not
    // additionally written to a file that couldn't be created.
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
