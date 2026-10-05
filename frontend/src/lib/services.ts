// Thin fetch wrappers around the TS manufacturing services — trimmed to
// what /production-planning's Gauges actually need. Everything else that
// used to live here (scheduling runs, Start/Complete, machine breakdown,
// what-if simulation) was Ledger's own duplicate of real operator/
// scheduling actions that now belong exclusively to APS Platform (see
// the removal of /execution, /operator, and /scheduling from this app).

import { internalServiceHeaders } from "@aps/shared/serviceAuth";

const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";
const REPORTING_SERVICE_URL = process.env.REPORTING_SERVICE_URL ?? "http://localhost:4016";

// Auth/Authz hardening, Phase 1 (Finding 1.1) — reporting-service/
// analytics-service now require the shared internal-service credential.
export async function fetchDeviationAnalysis(plantId: string) {
  try {
    const response = await fetch(
      `${REPORTING_SERVICE_URL}/reports/deviation-analysis?plantId=${encodeURIComponent(plantId)}`,
      { cache: "no-store", headers: internalServiceHeaders() }
    );
    if (!response.ok) return null;
    return (await response.json()) as {
      totalOrders: number;
      lateOrders: number;
      onTimePct: number | null;
      avgTardinessMin: number;
      productivityPct: number | null;
    };
  } catch {
    return null; // reporting-service not running — gauges degrade gracefully rather than erroring
  }
}

export async function fetchScrap(from: string, to: string) {
  try {
    const response = await fetch(
      `${ANALYTICS_SERVICE_URL}/analytics/scrap?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { cache: "no-store", headers: internalServiceHeaders() }
    );
    if (!response.ok) return null;
    return (await response.json()) as { scrapPct: number | null; scrapUnits: number; totalUnits: number };
  } catch {
    return null;
  }
}
