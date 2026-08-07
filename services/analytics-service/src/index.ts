process.env.SERVICE_NAME = "analytics-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { chQuery, chQueryJSON } from "./clickhouse";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4017);

function escape(value: string): string {
  return value.replace(/'/g, "\\'");
}

// ClickHouse's DateTime type parses 'YYYY-MM-DD HH:MM:SS', not ISO 8601's
// 'T'/'Z' — every query filtering on scheduled_start must convert first.
// (Previously only the INSERT endpoint did this; every read endpoint passed
// the raw ISO string straight into the WHERE clause, a latent bug masked
// until now because completed_operations was always empty in every earlier
// test — confirmed via a real ClickHouse 400 once real rows existed.)
function toClickhouseDateTime(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

// §11: "Analytics Service — ClickHouse OLAP queries, OEE trends, bottleneck
// history — GET /analytics/*"

app.post("/analytics/completed-operations", async (req, res) => {
  const op = req.body as {
    operationId: string;
    machineId: string;
    productionOrderId: string;
    scheduledStart: string;
    scheduledEnd: string;
    actualStart?: string;
    actualEnd?: string;
    goodUnits: number;
    totalUnits: number;
    scrapUnits: number;
    setupTimeMin: number;
    processingTimeMin: number;
    downtimeMin: number;
  };

  const nullableDateTime = (iso?: string) => (iso ? `'${toClickhouseDateTime(iso)}'` : "NULL");

  await chQuery(`
    INSERT INTO completed_operations
    (operation_id, machine_id, production_order_id, scheduled_start, scheduled_end, actual_start, actual_end, good_units, total_units, scrap_units, setup_time_min, processing_time_min, downtime_min)
    VALUES (
      '${escape(op.operationId)}', '${escape(op.machineId)}', '${escape(op.productionOrderId)}',
      '${toClickhouseDateTime(op.scheduledStart)}', '${toClickhouseDateTime(op.scheduledEnd)}',
      ${nullableDateTime(op.actualStart)}, ${nullableDateTime(op.actualEnd)},
      ${op.goodUnits}, ${op.totalUnits}, ${op.scrapUnits},
      ${op.setupTimeMin}, ${op.processingTimeMin}, ${op.downtimeMin}
    )
  `);
  res.status(201).json({ inserted: true });
});

// §10 OEE = Availability × Performance × Quality (each a 0-100 percentage;
// Overall divides by 100^2 to renormalize the product back to a percentage).
app.get("/analytics/oee", async (req, res) => {
  const { machineId, from, to } = req.query as { machineId?: string; from?: string; to?: string };
  if (!machineId || !from || !to) {
    res.status(400).json({ error: "machineId, from, and to are required" });
    return;
  }

  const rows = await chQueryJSON<{
    scheduled_min: string;
    downtime_min: string;
    good_units: string;
    total_units: string;
    processing_min: string;
    actual_min: string;
  }>(`
    SELECT
      sum(dateDiff('minute', scheduled_start, scheduled_end)) AS scheduled_min,
      sum(downtime_min) AS downtime_min,
      sum(good_units) AS good_units,
      sum(total_units) AS total_units,
      sum(processing_time_min) AS processing_min,
      sum(if(actual_start IS NOT NULL AND actual_end IS NOT NULL, toFloat64(dateDiff('minute', actual_start, actual_end)), toFloat64(processing_time_min))) AS actual_min
    FROM completed_operations
    WHERE machine_id = '${escape(machineId)}'
      AND scheduled_start >= '${toClickhouseDateTime(from)}' AND scheduled_start <= '${toClickhouseDateTime(to)}'
  `);

  const r = rows[0];
  if (!r || Number(r.scheduled_min) === 0) {
    res.json({ availabilityPct: null, performancePct: null, qualityPct: null, oeeOverallPct: null });
    return;
  }

  const availabilityPct = ((Number(r.scheduled_min) - Number(r.downtime_min)) / Number(r.scheduled_min)) * 100;
  const performancePct = Number(r.actual_min) > 0 ? (Number(r.processing_min) / Number(r.actual_min)) * 100 : null;
  const qualityPct = Number(r.total_units) > 0 ? (Number(r.good_units) / Number(r.total_units)) * 100 : null;
  const oeeOverallPct =
    performancePct != null && qualityPct != null ? (availabilityPct * performancePct * qualityPct) / 10_000 : null;

  res.json({ availabilityPct, performancePct, qualityPct, oeeOverallPct });
});

// §10 Bottleneck Index: work centre/machine with the highest sustained
// load % over the rolling window — proxy denominator is wall-clock minutes
// in the window (no shift-calendar join here; calendar-service owns that).
app.get("/analytics/bottleneck", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) {
    res.status(400).json({ error: "from and to are required" });
    return;
  }
  const windowMinutes = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;

  const rows = await chQueryJSON<{ machine_id: string; busy_min: string }>(`
    SELECT machine_id, sum(processing_time_min + setup_time_min) AS busy_min
    FROM completed_operations
    WHERE scheduled_start >= '${toClickhouseDateTime(from)}' AND scheduled_start <= '${toClickhouseDateTime(to)}'
    GROUP BY machine_id
    ORDER BY busy_min DESC
  `);

  const ranked = rows.map((r) => ({ machineId: r.machine_id, loadPct: (Number(r.busy_min) / windowMinutes) * 100 }));
  res.json({ bottleneck: ranked[0] ?? null, ranked });
});

// §10 "Scrap % = Scrap_qty / Total_produced × 100".
app.get("/analytics/scrap", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) {
    res.status(400).json({ error: "from and to are required" });
    return;
  }

  const rows = await chQueryJSON<{ scrap_units: string; total_units: string }>(`
    SELECT sum(scrap_units) AS scrap_units, sum(total_units) AS total_units
    FROM completed_operations
    WHERE scheduled_start >= '${toClickhouseDateTime(from)}' AND scheduled_start <= '${toClickhouseDateTime(to)}'
  `);

  const r = rows[0];
  const totalUnits = r ? Number(r.total_units) : 0;
  const scrapPct = totalUnits > 0 ? (Number(r.scrap_units) / totalUnits) * 100 : null;

  res.json({ scrapPct, scrapUnits: r ? Number(r.scrap_units) : 0, totalUnits });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`analytics-service listening on :${PORT}`);
});
