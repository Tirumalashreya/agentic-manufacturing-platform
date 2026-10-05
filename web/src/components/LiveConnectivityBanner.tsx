"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type LiveEvent = { topic: string; message: Record<string, unknown>; at: string };

const TOPIC_LABEL: Record<string, string> = {
  "orders.production.created": "Production order created",
  "orders.production.updated": "Production order updated",
  "schedule.published": "Schedule published",
};

// The point of this whole app being a genuinely separate deployment (own
// port, own login) from the Sales Ledger is lost if nothing here actually
// reacts to what happens over there — otherwise it's just a second app
// polling its own database, no more "connected" than one screen in the
// other app was. This subscribes to the real Kafka events every other
// cross-service integration in this codebase already uses (order
// creation, schedule publication) via a small SSE relay
// (notification-service), and reacts to them live: a visible banner
// naming what happened, plus a real data refresh (not just a toast) so
// the page underneath is actually current, not merely told something
// changed.
export function LiveConnectivityBanner() {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Real bug found live: this used to connect straight to
    // notification-service's own port — a direct cross-origin call that
    // Phase 1's auth hardening broke (blocked by CORS in the browser,
    // since EventSource can't attach the internal-service token the
    // backend now requires). Routes through this app's own same-origin
    // proxy instead (see app/api/events/stream/route.ts), which attaches
    // the token server-side and relays the stream through.
    const source = new EventSource("/api/events/stream");

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(evt.data) as LiveEvent;
        setLastEvent(parsed);
        router.refresh();
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setLastEvent(null), 6000);
      } catch {
        // Heartbeat/comment lines never reach onmessage (SSE spec skips
        // lines starting with ":"); a genuine parse failure here means a
        // malformed payload, not something to crash the page over.
      }
    };

    return () => {
      source.close();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [router]);

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-muted px-6 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-muted">
        <span
          className={`h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-danger"}`}
          style={connected ? { boxShadow: "0 0 0 3px var(--success-soft)" } : undefined}
        />
        {connected ? "Live — connected to Sales" : "Reconnecting…"}
      </span>
      {lastEvent && (
        <span className="flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-0.5 font-medium text-brand-700 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-300">
          📡 {TOPIC_LABEL[lastEvent.topic] ?? lastEvent.topic} — just now
        </span>
      )}
    </div>
  );
}
