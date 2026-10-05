import type { StatusTone } from "@/components/ui/StatusBadge";

// One real place for the tone semantics behind the two status enums that
// recur across Production Planning, Orders/Order Detail, My Jobs and
// Schedule (design-system pass, agreed with the user) — previously each
// page redefined its own version of these two functions independently.

// Real ScheduledOpStatus values (packages/domain/prisma/schema.prisma).
export function opStatusTone(status: string): StatusTone {
  if (status === "DONE") return "success";
  if (status === "BLOCKED") return "danger";
  if (status === "IN_PROGRESS") return "warning";
  return "neutral";
}

// Real ProductionOrder.status values.
export function orderStatusTone(status: string): StatusTone {
  if (status === "COMPLETED") return "success";
  if (status === "CANCELLED") return "danger";
  if (status === "IN_PROGRESS" || status === "RELEASED") return "warning";
  return "neutral";
}

// Real LatenessStatus values (lib/lateness.ts).
export function latenessTone(status: string): StatusTone {
  if (status === "LATE") return "danger";
  if (status === "AT_RISK") return "warning";
  if (status === "ON_TRACK") return "success";
  return "neutral";
}

// Real FulfillmentLineStatus values (packages/domain/prisma/schema.prisma) —
// added for the Order Control Center's Fulfillment panel (Phase 3, agreed
// with the user).
export function fulfillmentLineStatusTone(status: string): StatusTone {
  if (status === "FULFILLED") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "ON_HOLD") return "warning";
  return "neutral";
}

// Real MachineStatus values (packages/domain/prisma/schema.prisma).
export function machineStatusTone(status: string): StatusTone {
  if (status === "AVAILABLE" || status === "RUNNING") return "success";
  if (status === "DOWN" || status === "OFFLINE") return "danger";
  if (status === "MAINTENANCE") return "warning";
  return "neutral";
}

// Real machine workload %, same 90/70 thresholds the Workload graph and
// Machines table both already used ad hoc before this pass.
export function loadTone(pct: number): StatusTone {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "success";
}
