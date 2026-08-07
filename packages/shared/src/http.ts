// Express 4 does not forward a rejected promise from an async route handler
// to error-handling middleware — it's an unhandled rejection that crashes
// the whole process. Confirmed for real: a duplicate-SKU insert in
// routing-service's POST /products took the entire service down, not just
// that one request, during bulk-import verification. This patches Router
// methods so async handlers' rejections reach the error middleware below
// instead — must be imported before any app.get/post/etc. is registered.
import "express-async-errors";
import express, { type Express } from "express";
import { logger } from "./logger";

// Every service calls this instead of hand-rolling its own express() + JSON
// body-parsing + health check — keeps the 18 services consistent without a
// shared framework dependency beyond plain express.
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });
  app.get("/health", (_req, res) => res.json({ status: "ok", service: process.env.SERVICE_NAME }));
  return app;
}

// Registered by each service after its routes (see individual index.ts
// files) — turns a thrown/rejected error into a clean JSON response instead
// of an unhandled-rejection crash. A Prisma unique-constraint violation
// (P2002) becomes a 409 with a readable message; everything else is a 500.
export function registerErrorHandler(app: Express): void {
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const prismaError = err as { code?: string; meta?: { target?: string[] } };
    if (prismaError.code === "P2002") {
      const fields = prismaError.meta?.target?.join(", ") ?? "field";
      res.status(409).json({ error: `A record with this ${fields} already exists` });
      return;
    }
    logger.error("Unhandled request error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  });
}
