import { internalServiceHeaders } from "@aps/shared/serviceAuth";

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? "http://localhost:4014";

// Real bug found live: LiveConnectivityBanner used to open an EventSource
// straight at notification-service's own port — a direct cross-origin
// browser call, the exact pattern Phase 1's auth hardening closed
// everywhere else. That hardening put requireServiceToken in front of
// every non-health route on every service (see packages/shared/src/
// serviceAuth.ts), including this one — but the browser's native
// EventSource API has no way to attach a custom header, so the request now
// always fails auth. Notification-service's own route still sets
// Access-Control-Allow-Origin: * (its original, pre-hardening design), but
// requireServiceToken rejects the request before that handler ever runs,
// and its rejection response carries no CORS header — which is exactly why
// the browser reports this as a CORS failure rather than a 401.
//
// Fixed the same way Ledger's production-planning crash was: same-origin
// proxy. The browser connects here instead of directly to port 4014; this
// route (running server-side, where custom headers are possible) attaches
// the real internal-service token and relays the raw SSE stream straight
// through. No auth() check here, matching every other route already under
// web/src/app/api/* (capacity-status, reschedule, plan-production, ...) —
// none of them gate on the caller's session either; this doesn't introduce
// a new, inconsistent security bar for just this one route.
export async function GET() {
  const upstream = await fetch(`${NOTIFICATION_SERVICE_URL}/events/stream`, {
    headers: internalServiceHeaders(),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("notification-service unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
