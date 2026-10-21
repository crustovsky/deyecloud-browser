// One ingest function for cron, manual trigger and backfill.
// A cursor in meta marks how far history has been fetched. Each run walks the
// cursor forward in day-sized chunks (with a 15 minute overlap) until it reaches now.

import type { Config } from "./config";
import { DeyeClient, DeyeHttpError, type StationItem, type StationPowerItem } from "./deye";
import { deleteMeta, getMeta, getMetaJson, setMeta } from "./meta";
import { MAX_GAP_S, rollupDay, type Daily, type Reading } from "./rollup";
import { addDays, dayEnd, dayStart, localDay } from "./time";

const OVERLAP_S = 15 * 60;
const CHUNK_S = 24 * 3600;
const CALL_SPACING_MS = 1500;
const LOCK_TTL_S = 120;
const BACKOFF_MIN_S = 60;
const BACKOFF_MAX_S = 30 * 60;
const DEFAULT_BACKFILL_DAYS = 30;
const ROWS_PER_STATEMENT = 16; // 6 params per row, D1 allows 100 bound params per statement

export interface IngestResult {
  reason: string;
  skipped?: string;
  chunks: number;
  rows: number;
  days: string[];
  cursor?: number;
  caughtUp?: boolean;
  error?: string;
}

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIngest(env: Env, cfg: Config, reason: string, maxChunks: number): Promise<IngestResult> {
  const db = env.DB;
  const result: IngestResult = { reason, chunks: 0, rows: 0, days: [] };

  const backoffUntil = Number(await getMeta(db, "backoff_until"));
  if (backoffUntil && backoffUntil > nowS()) {
    result.skipped = `backoff until ${new Date(backoffUntil * 1000).toISOString()}`;
    return result;
  }
  if (!(await acquireLock(db))) {
    result.skipped = "another run in progress";
    return result;
  }

  try {
    const client = new DeyeClient(env, db);
    const stationId = await resolveStation(cfg, db, client);
    const backfillStart = backfillStartTs(cfg);
    let cursor = Number(await getMeta(db, "cursor")) || backfillStart;
    const touched = new Set<string>();

    while (result.chunks < maxChunks) {
      const now = nowS();
      if (now - cursor < 60) break;
      const from = Math.max(cursor - OVERLAP_S, backfillStart);
      const to = Math.min(from + CHUNK_S, now);

      if (result.chunks > 0) await sleep(CALL_SPACING_MS);
      const items = await client.stationHistoryPower(stationId, from, to);
      const readings = items.map((i) => toReading(i, cfg.powerUnit)).filter((r): r is Reading => r != null);

      await upsertReadings(db, readings);
      for (const r of readings) touched.add(localDay(r.ts, cfg.tz));
      result.rows += readings.length;
      result.chunks++;

      cursor = to;
      await setMeta(db, "cursor", String(cursor));
    }
    result.cursor = cursor;
    result.caughtUp = nowS() - cursor < 60;

    // The last sample of the previous day closes its interval against the first of a touched day.
    const days = [...touched].sort();
    if (days.length) touched.add(addDays(days[0], -1));
    result.days = [...touched].sort();
    for (const day of result.days) await rollupAndStore(db, cfg, day);

    await deleteMeta(db, "backoff_until");
    await deleteMeta(db, "backoff_s");
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    if (e instanceof DeyeHttpError) await scheduleBackoff(db, e.retryAfterS);
    console.error(JSON.stringify({ message: "ingest failed", reason, error: result.error }));
  } finally {
    await setMeta(db, "last_run", { at: nowS(), ...result });
    await deleteMeta(db, "lock");
  }
  return result;
}

function backfillStartTs(cfg: Config): number {
  if (cfg.backfillFrom) return dayStart(cfg.backfillFrom, cfg.tz);
  const today = localDay(nowS(), cfg.tz);
  return dayStart(addDays(today, -DEFAULT_BACKFILL_DAYS), cfg.tz);
}

async function acquireLock(db: D1Database): Promise<boolean> {
  const now = nowS();
  const res = await db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('lock', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1 WHERE CAST(meta.value AS INTEGER) < ?2",
    )
    .bind(String(now), now - LOCK_TTL_S)
    .run();
  return res.meta.changes > 0;
}

async function scheduleBackoff(db: D1Database, retryAfterS: number | null): Promise<void> {
  const prev = Number(await getMeta(db, "backoff_s")) || 0;
  const next = retryAfterS ?? Math.min(prev ? prev * 2 : BACKOFF_MIN_S, BACKOFF_MAX_S);
  await setMeta(db, "backoff_s", String(next));
  await setMeta(db, "backoff_until", String(nowS() + next));
}

async function resolveStation(cfg: Config, db: D1Database, client: DeyeClient): Promise<number> {
  const cached = await getMeta(db, "station_id");
  if (cached) return Number(cached);
  const stations = await client.stationList();
  if (!stations.length) throw new Error("no stations on this account");
  const pick: StationItem = (cfg.stationName && stations.find((s) => s.name === cfg.stationName)) || stations[0];
  await setMeta(db, "station_id", String(pick.id));
  await setMeta(db, "station", pick);
  return pick.id;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseTs(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e11 ? Math.round(n / 1000) : Math.round(n);
  const ms = Date.parse(String(v));
  return Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

// Maps one API frame onto our sign conventions:
// grid positive = import, battery positive = discharging.
//
// What the plant API actually returns (checked against a real hybrid inverter):
// - batteryPower is signed, positive while discharging; chargePower is reported negative.
// - gridPower is null and purchasePower equals wirePower in every frame, so the API only
//   gives the grid magnitude. The direction comes from the power balance: whatever the
//   house uses beyond what PV and the battery supply must come from the grid, and any
//   surplus must go out. Inverter losses (about 100 W) bias this toward import, which
//   only misclassifies exports smaller than that.
export function toReading(item: StationPowerItem, unit: "W" | "kW"): Reading | null {
  const ts = parseTs(item.timeStamp);
  if (ts == null) return null;
  const k = unit === "kW" ? 1 : 1 / 1000;
  const scale = (v: number | null | undefined) => {
    const n = num(v);
    return n == null ? null : n * k;
  };

  const pv = scale(item.generationPower);
  const load = scale(item.consumptionPower);

  const charge = scale(item.chargePower);
  const discharge = scale(item.dischargePower);
  const battery = scale(item.batteryPower) ?? (charge == null && discharge == null ? null : (discharge ?? 0) - Math.abs(charge ?? 0));

  const gridMag = scale(item.gridPower) ?? scale(item.purchasePower) ?? scale(item.wirePower);
  let grid: number | null = null;
  if (gridMag != null) {
    const net = (load ?? 0) - (pv ?? 0) - (battery ?? 0);
    grid = net >= 0 ? Math.abs(gridMag) : -Math.abs(gridMag);
  }

  const r: Reading = { ts, pv_kw: pv, load_kw: load, grid_kw: grid, battery_kw: battery, soc: num(item.batterySOC) };
  const empty = r.pv_kw == null && r.load_kw == null && r.grid_kw == null && r.battery_kw == null && r.soc == null;
  return empty ? null : r;
}

async function upsertReadings(db: D1Database, rows: Reading[]): Promise<void> {
  if (!rows.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const batch = rows.slice(i, i + ROWS_PER_STATEMENT);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const sql =
      `INSERT INTO readings (ts, pv_kw, load_kw, grid_kw, battery_kw, soc) VALUES ${placeholders} ` +
      "ON CONFLICT(ts) DO UPDATE SET pv_kw = excluded.pv_kw, load_kw = excluded.load_kw, " +
      "grid_kw = excluded.grid_kw, battery_kw = excluded.battery_kw, soc = excluded.soc";
    const params = batch.flatMap((r) => [r.ts, r.pv_kw, r.load_kw, r.grid_kw, r.battery_kw, r.soc]);
    stmts.push(db.prepare(sql).bind(...params));
  }
  await db.batch(stmts);
}

export async function rollupAndStore(db: D1Database, cfg: Config, day: string): Promise<Daily> {
  const { results } = await db
    .prepare("SELECT ts, pv_kw, load_kw, grid_kw, battery_kw, soc FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts")
    .bind(dayStart(day, cfg.tz), dayEnd(day, cfg.tz) + MAX_GAP_S)
    .all<Reading>();
  const d = rollupDay(day, results, cfg);
  await db
    .prepare(
      "INSERT INTO daily (day, pv_kwh, load_kwh, import_peak_kwh, import_offpeak_kwh, export_kwh, batt_charge_kwh, batt_discharge_kwh, soc_min, soc_max, samples) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET " +
        "pv_kwh = excluded.pv_kwh, load_kwh = excluded.load_kwh, import_peak_kwh = excluded.import_peak_kwh, " +
        "import_offpeak_kwh = excluded.import_offpeak_kwh, export_kwh = excluded.export_kwh, batt_charge_kwh = excluded.batt_charge_kwh, " +
        "batt_discharge_kwh = excluded.batt_discharge_kwh, soc_min = excluded.soc_min, soc_max = excluded.soc_max, samples = excluded.samples",
    )
    .bind(
      d.day,
      d.pv_kwh,
      d.load_kwh,
      d.import_peak_kwh,
      d.import_offpeak_kwh,
      d.export_kwh,
      d.batt_charge_kwh,
      d.batt_discharge_kwh,
      d.soc_min,
      d.soc_max,
      d.samples,
    )
    .run();
  return d;
}

export async function lastRun(db: D1Database): Promise<(IngestResult & { at: number }) | null> {
  return getMetaJson<IngestResult & { at: number }>(db, "last_run");
}
