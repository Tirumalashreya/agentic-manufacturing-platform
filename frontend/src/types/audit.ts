// Mirrors audit_tools.AUDIT_EVENT_HEADERS — the shared, append-only event
// log wired into every real status transition across Project, Export,
// Trading, Service, Consignment, Financial, and Post-Sales.
export type AuditEvent = {
  event_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
};
