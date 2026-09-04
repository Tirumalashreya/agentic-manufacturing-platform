# APS Platform — Session Summary

A record of everything built, fixed, and verified in this session, on top of the existing Enterprise Manufacturing APS Platform.

## Features built

### Operator scheduling (Proficy + Fulcrum-style)
- Schema: `RoutingOperation.requiredSkillId` / `minProficiency` — lets a routing step require a specific skill at a minimum proficiency.
- `/operators` page: manual add-operator form (employee ID, name, department, employment type), skill/proficiency assignment, shift assignment, plus a **bulk import widget** scoped to just Shift/Operator sheets.
- Pipeline wiring (`services/scheduling-service/src/pipeline.ts`): the real scheduling engine now resolves a qualified, available operator for each operation — shift coverage, skill/proficiency match, and a real conflict check against existing bookings. Additive and guarded: a plant with zero operators schedules exactly as before (verified with a real before/after regression check).
- `/schedule` Gantt: a second **Operators** row section (Proficy-style), same chart as the machine rows, built from operations that got a real operator assigned.
- `/my-jobs`: Fulcrum-style Job Tracker — pick an operator, see their queue sorted by start time, Start/Complete/Block right there.

### Disruption Simulator
- Panel on `/schedule`: buttons to report a real machine breakdown, cancel an order, or change an order's quantity — each fires the same real event a live MES/ERP integration would, and the scheduler replans automatically via a background Kafka consumer, no manual "Run Scheduling" needed.
- Runtime on/off toggle for the demo auto-progress ticker (`PATCH /scheduling/demo-ticker`) — previously only controllable via an environment variable and a service restart.

### Bulk import — extended and made more flexible
- Added `Operator` and `Shift` as real importable entity types alongside the existing Machine/Product/Routing/Customer/Order — skills and shift assignments ride along on the Operator row itself (comma-separated, same pattern as Machine's Capabilities column).
- **Default-fallback for missing structural concepts**: a file with no work-center concept at all still imports (machines land in one auto-created "DEFAULT" work center); a file with no customer concept still imports (orders land under one auto-created "Unassigned" customer). Previously these were hard-required and would fail the whole sheet.
- **Delete Order** (`/orders`) and **Delete Operator** (`/operators`) — real hard-delete buttons with a two-step confirm. Deleting an order removes its scheduled operations/reservations; deleting an operator unassigns (not deletes) any real work they were on, reverting it to machine-only.

### Demo dataset
- A realistic CNC machine-shop dataset: 6 work centers, 12 machines, 8 products with multi-step routings, 6 customers, 18 orders (due dates staggered 1–2 weeks out), 8 operators with real skills/shifts.
- Generator scripts (regenerate before recording so due dates stay fresh):
  - `gen-machine-shop.js` → `machine-shop-demo.xlsx`
  - `gen-operators.js` → `operators-demo.xlsx`
  - Both copied to `~/Downloads/` for easy upload via the browser.

## Real bugs found and fixed

1. **Gantt lateness dot was invisible** — the red/amber delivery-risk corner dot sat inside a container with `overflow-hidden` while being positioned partially outside its own box on purpose; the parent silently clipped it. Fixed by moving the dot outside the clipped wrapper.
2. **Capacity-engine bucket-flooring bug** — `getAvailableWindows` rounded a requested earliest-start time down to the nearest 15-minute grid line before querying capacity, which could return a window starting up to 14 minutes *before* the real floor. In practice this meant a successor operation could get scheduled before its own predecessor actually finished. Fixed by clamping every returned window's start to the exact, unfloored requested time (`packages/domain/src/capacity-engine.ts`).
3. **Machine capability exact-match requirement** — the scheduler requires an exact string match between a machine's declared capability and a routing operation's literal name (not a broad category). The demo workbook's `Capabilities` column originally used generic categories ("MILLING," "TURNING"), which meant zero machines ever matched any operation and scheduling silently placed nothing. Fixed both the live data and the actual generator script.
4. **Fuzzy-match synonym collisions** — three real classification bugs found while extending the importer:
   - Bare `"days"` synonym coincidentally matched `SlaDays`/`LeadTimeDays`, misclassifying a Customers sheet as a Shifts sheet.
   - Bare `"station"` synonym coincidentally matched a `Status` column (~0.55 similarity), misreading a machine's status as its work center code.
   - `ProductSKU` had no `"partnumber"`/`"itemnumber"` synonyms, a very common real-world naming choice.
   All three fixed in `web/src/lib/fuzzy-match.ts`.
5. **Gantt hover-card CSS dead zone** — the operation hover card (with Start/Complete/Block buttons) was positioned 4px below its trigger bar using a margin. That 4px gap was a dead zone with nothing rendered in it, breaking the CSS `:hover` chain right as the cursor moved down toward the buttons. Fixed by converting that spacing from an external margin to internal padding, so the hoverable box and the visual gap are the same thing.
6. **Client/server boundary crash** — a client component (`ImportForm.tsx`) briefly imported a real value from `setup-import.ts`, which pulled Prisma → `pg` → Node's `dns` module into the browser bundle ("Module not found: Can't resolve 'dns'"). Fixed by splitting `EntityType`/`ENTITY_TYPES` into a small dependency-free file (`web/src/lib/entity-types.ts`) safe for both client and server code.
7. **Scheduling is not idempotent** — re-running "Run Scheduling" reprocesses every `PLANNED`/`RELEASED` order again and adds a fresh set of operations on top, rather than skipping already-scheduled orders. Documented as a known behavior, not fixed (would need a deliberate design decision on what "re-run" should mean).

## Reference

- Demo script (artifact, updated with deeper What-If/Disruption Simulator explanations): https://claude.ai/code/artifact/88687ef3-a816-4ff7-a38c-4c3b7c84c9a8
- System recap / Proficy feature comparison (artifact): https://claude.ai/code/artifact/73784b07-269b-478e-bdeb-ebb9549ea606

## Known, flagged, not acted on
- ~400 rows in the `Customer` table look like leftover garbage from much earlier real-file testing (machine-shaped names like "M001," "DRILL-01") — unrelated to this session's work, left alone since it wasn't part of any explicit request.
