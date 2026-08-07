process.env.SERVICE_NAME = "notification-service";

import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { Resend } from "resend";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4014);

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

startConsumers().catch((error) => logger.error("Kafka consumers failed to start", { error: String(error) }));

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`notification-service listening on :${PORT}`);
});
