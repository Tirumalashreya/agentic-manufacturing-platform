// Exact topic names from §11's "Key Kafka Topics" table — every producer and
// consumer across services imports from here so a typo can't create two
// different topics that were meant to be the same one.
export const TOPICS = {
  ORDERS_PRODUCTION_CREATED: "orders.production.created",
  ORDERS_PRODUCTION_UPDATED: "orders.production.updated",
  SCHEDULE_PUBLISHED: "schedule.published",
  MACHINES_BREAKDOWN_REPORTED: "machines.breakdown.reported",
  MAINTENANCE_ORDERS_CREATED: "maintenance.orders.created",
  INVENTORY_SHORTAGE_DETECTED: "inventory.shortage.detected",
  MACHINES_STATUS_CHANGED: "machines.status.changed",
  MACHINES_SENSORS: "machines.sensors.readings",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];
