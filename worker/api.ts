// Small JSON API read by the static pages. All paths start with /api/.

import type { Config } from "./config";
import { allMeta, getMetaJson } from "./meta";
import { lastRun, rollupAndStore, runIngest } from "./ingest";
import type { Reading } from "./rollup";
import { addDays, dayEnd, dayStart, isDay, localDay, zoneFor, type Zone } from "./time";

const MANUAL_MIN_GAP_S = 60;
const MAX_MANUAL_CHUNKS = 30;
const MAX_RANGE_DAYS = 400;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleApi(request: Request, env: Env, cfg: Config): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  if (request.method === "GET" && path === "/api/config") {
    const station = await getMetaJson<{ name?: string }>(db, "station");
    return json({
      title: cfg.title || station?.name || cfg.stationName || "Energy",
      stationName: station?.name ?? cfg.stationName ?? "",
      timezone: cfg.tz,
      offpeak: cfg.offpeak,
      gauges: cfg.gauges,
    });
  }

  if (request.method === "GET" && path === "/api/status") {
    const meta = await allMeta(db);
    const calls = Object.fromEntries(
      Object.entries(meta)
        .filter(([k]) => k.startsWith("api_calls:"))
        .map(([k, v]) => [k.slice("api_calls:".length), Number(v)]),
    );
    const parse = (k: string) => (meta[k] ? JSON.parse(meta[k]) : null);
    return json({
      now,
      cursor: Number(meta.cursor) || null,
      lastRun: parse("last_run"),
      station: parse("station"),
      backoffUntil: Number(meta.backoff_until) || null,
      apiCalls: calls,
      rateLimitHeaders: parse("ratelimit_headers"),
      config: { timezone: cfg.tz, offpeak: cfg.offpeak, powerUnit: cfg.powerUnit, backfillFrom: cfg.backfillFrom },
    });
  }

  if (request.method === "GET" && path === "/api/latest") {
    const latest = await db
      .prepare("SELECT ts, pv_kw, load_kw, grid_kw, battery_kw, soc FROM readings ORDER BY ts DESC LIMIT 1")
      .first<Reading>();
    const today = latest ? localDay(latest.ts, cfg.tz) : localDay(now, cfg.tz);
    const daily = await db.prepare("SELECT * FROM daily WHERE day = ?").bind(today).first();
    return json({ latest, today: daily });
  }

  if (request.method === "GET" && path === "/api/day") {
    const day = url.searchParams.get("date") ?? localDay(now, cfg.tz);
    if (!isDay(day)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    const start = dayStart(day, cfg.tz);
    const end = dayEnd(day, cfg.tz);
    const { results } = await db
      .prepare("SELECT ts, pv_kw, load_kw, grid_kw, battery_kw, soc FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts")
      .bind(start, end)
      .all<Reading>();
    const daily = await db.prepare("SELECT * FROM daily WHERE day = ?").bind(day).first();
    return json({ day, start, end, rows: results, daily, zones: zoneSegments(start, end, cfg) });
  }

  if (request.method === "GET" && path === "/api/daily") {
    const to = url.searchParams.get("to") ?? localDay(now, cfg.tz);
    const from = url.searchParams.get("from") ?? addDays(to, -29);
    if (!isDay(from) || !isDay(to) || from > to) return json({ error: "from/to must be YYYY-MM-DD, from <= to" }, 400);
    if (addDays(from, MAX_RANGE_DAYS) < to) return json({ error: `range over ${MAX_RANGE_DAYS} days` }, 400);
    const { results } = await db
      .prepare("SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day")
      .bind(from, to)
      .all();
    return json({ from, to, rows: results });
  }

  if (request.method === "POST" && path === "/api/ingest") {
    const last = await lastRun(db);
    if (last && now - last.at < MANUAL_MIN_GAP_S) {
      return json({ skipped: `last run ${now - last.at}s ago`, lastRun: last }, 429);
    }
    const chunks = Math.min(Number(url.searchParams.get("chunks")) || 3, MAX_MANUAL_CHUNKS);
    return json(await runIngest(env, cfg, "manual", chunks));
  }

  // Recompute daily totals from stored readings, e.g. after changing OFFPEAK_HOURS or TIMEZONE.
  if (request.method === "POST" && path === "/api/rollup") {
    const to = url.searchParams.get("to") ?? localDay(now, cfg.tz);
    const from = url.searchParams.get("from") ?? addDays(to, -29);
    if (!isDay(from) || !isDay(to) || from > to) return json({ error: "from/to must be YYYY-MM-DD, from <= to" }, 400);
    if (addDays(from, MAX_RANGE_DAYS) < to) return json({ error: `range over ${MAX_RANGE_DAYS} days` }, 400);
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      await rollupAndStore(db, cfg, d);
      days.push(d);
    }
    return json({ from, to, days: days.length });
  }

  return json({ error: "not found" }, 404);
}

// Consecutive tariff zone segments covering [start, end), for shading the day chart.
function zoneSegments(start: number, end: number, cfg: Config): { start: number; end: number; zone: Zone }[] {
  const out: { start: number; end: number; zone: Zone }[] = [];
  for (let t = start; t < end; t += 300) {
    const zone = zoneFor(t, cfg.tz, cfg.offpeak);
    const last = out[out.length - 1];
    if (last && last.zone === zone) last.end = t + 300;
    else out.push({ start: t, end: t + 300, zone });
  }
  return out;
}
