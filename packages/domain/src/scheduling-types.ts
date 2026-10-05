export type SchedulingMode = "FORWARD" | "BACKWARD" | "BOTTLENECK";

// What-If simulation: hypothetically add N more machines' worth of capacity
// to a work center (the "add operators/machines" lever from real scheduling
// tools) and see whether it relieves a bottleneck — before actually doing
// it. Scoped to this one lever for v1: "extra shift hours" doesn't have a
// meaningful analogue here yet, since a work center with no Shift rows
// configured (true for every plant today, per the shift-calendar work) is
// already unconstrained by time-of-day, so "add more hours" would be a
// no-op against the current baseline.
export type CapacityAdjustment = { workCenterId: string; additionalMachineCount: number };
