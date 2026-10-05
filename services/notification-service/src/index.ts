process.env.SERVICE_NAME = "notification-service";

import type { Response } from "express";
import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { Resend } from "resend";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4014);

// Real gap found live: reviving web/ as its own genuinely separate
// dashboard (its own host, its own port) only proves "connectivity"
// between it and the Sales side if something actually pushes to it —
// otherwise it's just another app polling its own database, no
// different in spirit from the single-dashboard version this replaces.
// This relays the real Kafka events already firing on order creation
// and schedule publication out to any connected browser as
// Server-Sent Events — genuine push, driven by the same message bus
// every other cross-service integration in this codebase already uses,
// not a new invented mechanism. No CORS middleware exists anywhere in
// this codebase (only agent-orchestrator, being Python/FastAPI, sets it
// up) — added narrowly here, permissive, since this is the one endpoint
// a browser on a different origin (web/ on :3001) needs to reach directly.
const sseClients = new Set<Response>();

function broadcast(topic: string, message: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify({ topic, message, at: new Date().toISOString() })}\n\n`;
  for (const client of sseClients) client.write(payload);
}

app.get("/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Idle SSE connections get silently dropped by some browsers/proxies
// without a periodic write — a comment line (ignored by EventSource,
// per spec) keeps the connection alive without ever surfacing as a
// real event to any listener.
setInterval(() => {
  for (const client of sseClients) client.write(": heartbeat\n\n");
}, 20_000);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const NOTIFY_TO = process.env.NOTIFICATION_EMAIL_TO;
const FROM = process.env.EMAIL_FROM ?? "APS Platform <onboarding@resend.dev>";

// §11: "Notification Service — Alerts via email/SMS/webhook/in-app —
// Consumes all alert topics". SMS/webhook/in-app are left as clearly-marked
// extension points (no SMS provider or webhook subscriber list exists to
// wire up in this environment) — email is real via the same Resend
// integration already proven out.
async function sendAlert(subject: string, body: string) {
  logger.info("Alert triggered", { subject, body });
  if (!resend || !NOTIFY_TO) {
    logger.warn("Email not sent — RESEND_API_KEY or NOTIFICATION_EMAIL_TO not configured", { subject });
    return;
  }
  await resend.emails.send({ from: FROM, to: NOTIFY_TO, subject, html: `<p>${body}</p>` });
}

async function startConsumers() {
  await ensureTopics([
    TOPICS.MACHINES_BREAKDOWN_REPORTED,
    TOPICS.INVENTORY_SHORTAGE_DETECTED,
    TOPICS.MAINTENANCE_ORDERS_CREATED,
  ]);

  await subscribe(
    "notification-service",
    [TOPICS.MACHINES_BREAKDOWN_REPORTED, TOPICS.INVENTORY_SHORTAGE_DETECTED, TOPICS.MAINTENANCE_ORDERS_CREATED],
    async (topic, message) => {
      switch (topic) {
        case TOPICS.MACHINES_BREAKDOWN_REPORTED:
          await sendAlert(
            "Machine breakdown reported",
            `Machine ${message.machineId} reported fault ${message.faultCode ?? "unknown"}.`
          );
          break;
        case TOPICS.INVENTORY_SHORTAGE_DETECTED:
          await sendAlert(
            "Inventory shortage detected",
            `Product ${message.productId} is short by ${message.required} units of required demand.`
          );
          break;
        case TOPICS.MAINTENANCE_ORDERS_CREATED:
          await sendAlert(
            "Maintenance order created",
            `A new maintenance order (${message.maintenanceOrderId}) was created for machine ${message.machineId}.`
          );
          break;
      }
    }
  );
  logger.info("Subscribed to all alert topics");
}

// Separate consumer group from the alert one above — this relays to
// connected dashboards, it doesn't send email, so it stays on its own
// subscription rather than overloading startConsumers's single handler.
async function startDashboardRelay() {
  await ensureTopics([TOPICS.ORDERS_PRODUCTION_CREATED, TOPICS.ORDERS_PRODUCTION_UPDATED, TOPICS.SCHEDULE_PUBLISHED]);
  await subscribe(
    "notification-service-dashboard-relay",
    [TOPICS.ORDERS_PRODUCTION_CREATED, TOPICS.ORDERS_PRODUCTION_UPDATED, TOPICS.SCHEDULE_PUBLISHED],
    async (topic, message) => {
      broadcast(topic, message);
      logger.info("Relayed event to connected dashboards", { topic, clients: sseClients.size });
    }
  );
  logger.info("Subscribed to dashboard-relay topics");
}

startConsumers().catch((error) => logger.error("Kafka consumers failed to start", { error: String(error) }));
startDashboardRelay().catch((error) => logger.error("Dashboard relay consumer failed to start", { error: String(error) }));

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`notification-service listening on :${PORT}`);
});
