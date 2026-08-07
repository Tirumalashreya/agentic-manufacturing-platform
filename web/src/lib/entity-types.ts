// Split out from setup-import.ts specifically so client components (like
// ImportForm's review screen) can import ENTITY_TYPES as a real value
// without pulling in setup-import.ts's server-only dependency chain
// (Prisma -> pg -> node:dns, which the browser bundle can't resolve).
export type EntityType =
  | "WorkCenter"
  | "Machine"
  | "Product"
  | "Routing"
  | "RoutingOperation"
  | "Customer"
  | "Order"
  | "Shift"
  | "Operator"
  | "Calendar"
  | "Holiday"
  | "CalendarSettings";

export const ENTITY_TYPES: EntityType[] = [
  "WorkCenter",
  "Machine",
  "Product",
  "Routing",
  "RoutingOperation",
  "Customer",
  "Order",
  "Shift",
  "Operator",
  "Calendar",
  "Holiday",
  "CalendarSettings",
];
