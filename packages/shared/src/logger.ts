import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Elasticsearch (§12) has no clean local install path on this machine (see
// build plan). This substitutes structured JSON-line logs — stdout plus a
// per-service file under infra/logs/ — which is what an ES ingest pipeline
// would consume anyway if one existed.
const LOG_DIR = path.resolve(__dirname, "../../../infra/logs");
mkdirSync(LOG_DIR, { recursive: true });

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
  appendFileSync(logFile, line + "\n");
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
