"use client";

import { useEffect, useMemo, useState } from "react";
import { listRecentAuditEvents } from "@/lib/api";
import type { AuditEvent } from "@/types/audit";
import { PageHeader, Panel, StatusBadge, AlertBanner } from "@/components/ui";

export default function AuditTrailPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    listRecentAuditEvents(200)
      .then(setEvents)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load audit events."));
  }, []);

  const filtered = useMemo(() => {
    if (!events) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return events;
    return events.filter((e) =>
      [e.entity_type, e.entity_id, e.event_type].some((field) => field.toLowerCase().includes(needle))
    );
  }, [events, filter]);

  return (
    <>
      <PageHeader
        kicker="SYSTEM"
        title="Audit trail"
        description={
          <>
            Every real status transition across Project, Export, Trading, Service, Consignment,
            Financial and Post-Sales lands here — one shared, append-only event log, not a bespoke
            history per entity. Newest first.
          </>
        }
      />

      {error && <AlertBanner tone="danger" title="Could not load events">{error}</AlertBanner>}

      <Panel title="Recent activity" subtitle={events === null ? "Loading..." : `${events.length} event(s) loaded (most recent 200).`}>
        <div className="field" style={{ maxWidth: 320, marginBottom: 16 }}>
          <label>FILTER</label>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Entity type, entity id, or event type..."
          />
        </div>

        {filtered && filtered.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-faint)" }}>
            {events && events.length > 0 ? "No events match that filter." : "No events recorded yet."}
          </p>
        )}

        {filtered && filtered.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Entity</th>
                  <th>Event</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((event) => (
                  <tr key={event.event_id}>
                    <td className="mono" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                      {event.created_at.replace("T", " ").slice(0, 19)}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 12.8 }}>{event.entity_type}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{event.entity_id}</div>
                    </td>
                    <td>
                      <StatusBadge tone="neutral">{event.event_type}</StatusBadge>
                    </td>
                    <td style={{ fontSize: 11.5, color: "var(--text-soft)", maxWidth: 320 }}>
                      {Object.keys(event.details).length > 0 ? JSON.stringify(event.details) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
