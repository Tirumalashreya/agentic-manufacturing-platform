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
  // Real production-exception reporting (agreed with the user) — fires
  // whenever a ProductionException row is created. No consumer exists
  // yet (capture/persist/notify only, per the agreed scope); a future
  // Inventory/Quality agent is the natural first real consumer.
  OPERATIONS_EXCEPTION_REPORTED: "operations.exception.reported",
  // Real material-lifecycle events (Phase 3, agreed with the user) — fires
  // for every real InventoryMovement row (GOODS_RECEIPT or GOODS_ISSUE).
  // No consumer yet; a future Inventory/Procurement agent is the natural
  // first real consumer, same pattern as OPERATIONS_EXCEPTION_REPORTED.
  INVENTORY_MOVEMENT_RECORDED: "inventory.movement.recorded",
  // Real Quality (Phase 4, agreed with the user) — fires for every real
  // QualityInspection row. No consumer yet; a future Quality agent is the
  // natural first real consumer, same pattern as every other new-topic
  // addition this session.
  QUALITY_INSPECTION_RECORDED: "quality.inspection.recorded",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];
