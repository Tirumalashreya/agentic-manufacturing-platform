process.env.SERVICE_NAME = "iot-ingestion";

import { createApp, registerErrorHandler, logger, publish, TOPICS } from "@aps/shared";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4020);

// §11 "IoT Ingestion — OPC-UA/SCADA → machine status events → Kafka —
// machines.sensors.*". No real PLC/SCADA hardware exists to read from, so
// this is a triggerable simulator (rather than a perpetual generator that
// would spam Kafka indefinitely) — machine-service is the real consumer
// that persists these as SensorReading rows, matching the doc's separation
// (IoT Ingestion only produces; Machine Service owns the data).
app.post("/iot/simulate-readings", async (req, res) => {
  const { machineId, sensorType, count, baseValue, noise } = req.body as {
    machineId: string;
    sensorType: string;
    count?: number;
    baseValue: number;
    noise?: number;
  };
  const n = count ?? 5;
  const readings = Array.from({ length: n }, () => baseValue + (Math.random() - 0.5) * 2 * (noise ?? baseValue * 0.05));

  for (const value of readings) {
    await publish(TOPICS.MACHINES_SENSORS, { machineId, sensorType, value, readingTime: new Date().toISOString() });
  }

  logger.info("Simulated sensor readings published", { machineId, sensorType, count: n });
  res.json({ published: n, readings });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`iot-ingestion listening on :${PORT}`);
});
