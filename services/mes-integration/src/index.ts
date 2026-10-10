import { logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { app } from "./app";

const PORT = Number(process.env.PORT ?? 4019);

app.listen(PORT, () => {
  logger.info(`mes-integration listening on :${PORT}`);
});

async function startConsumer() {
  await ensureTopics([TOPICS.SCHEDULE_PUBLISHED]);
  await subscribe("mes-integration", [TOPICS.SCHEDULE_PUBLISHED], async (_topic, message) => {
    logger.info("Simulated work-order dispatch to shop-floor MES", message);
  });
  logger.info("Subscribed to schedule.published");
}
startConsumer().catch((error) => logger.error("Kafka consumer failed to start", { error: String(error) }));
