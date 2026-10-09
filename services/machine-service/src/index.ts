import { logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { prisma } from "@aps/domain";
import { app } from "./app";

const PORT = Number(process.env.PORT ?? 4008);

app.listen(PORT, () => {
  logger.info(`machine-service listening on :${PORT}`);
});

// §11: machines.sensors.* is produced by IoT Ingestion; Machine Service is
// the consumer that owns persisting it as SensorReading rows.
async function startConsumer() {
  await ensureTopics([TOPICS.MACHINES_SENSORS]);
  await subscribe("machine-service", [TOPICS.MACHINES_SENSORS], async (_topic, message) => {
    const { machineId, sensorType, value } = message as { machineId: string; sensorType: string; value: number };
    await prisma.sensorReading.create({ data: { machineId, sensorType, value } });
  });
  logger.info("Subscribed to machines.sensors.readings");
}
startConsumer().catch((error) => logger.error("Kafka consumer failed to start", { error: String(error) }));
