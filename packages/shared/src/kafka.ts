import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";
import type { TopicName } from "./topics";

// Real kafkajs client against the real local broker (brew-installed Kafka
// 4.x, KRaft mode, verified reachable on :9092 this session) — not a stub.
const kafka = new Kafka({
  clientId: process.env.SERVICE_NAME ?? "aps-service",
  brokers: [process.env.KAFKA_BROKER ?? "localhost:9092"],
  logLevel: logLevel.NOTHING,
});

let producer: Producer | null = null;

async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer();
    await producer.connect();
  }
  return producer;
}

export async function publish(topic: TopicName, message: Record<string, unknown>) {
  const p = await getProducer();
  await p.send({
    topic,
    messages: [{ value: JSON.stringify(message) }],
  });
}

export async function subscribe(
  groupId: string,
  topics: TopicName[],
  onMessage: (topic: string, message: Record<string, unknown>) => Promise<void> | void
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      const parsed = JSON.parse(message.value.toString());
      await onMessage(topic, parsed);
    },
  });
  return consumer;
}

export async function ensureTopics(topics: TopicName[]) {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  const toCreate = topics.filter((t) => !existing.includes(t));
  if (toCreate.length > 0) {
    await admin.createTopics({
      topics: toCreate.map((topic) => ({ topic, numPartitions: 1 })),
    });
  }
  await admin.disconnect();
}
