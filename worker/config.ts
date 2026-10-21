// Turns the string vars from wrangler.jsonc into typed config with defaults.

export interface HourRange {
  start: number; // inclusive, 0-23
  end: number; // exclusive, 1-24; a range may wrap past midnight (22-6)
}

export interface Config {
  title: string;
  tz: string;
  offpeak: HourRange[];
  powerUnit: "W" | "kW";
  stationName: string;
  backfillFrom: string; // YYYY-MM-DD or ""
  gauges: { pv: number; grid: number; battery: number; load: number };
  allowPublic: boolean;
}

// "22-6,13-15" -> [{22,6},{13,15}]
export function parseHourRanges(text: string): HourRange[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (!m) throw new Error(`bad hour range: ${s}`);
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (start > 23 || end > 24 || start === end) throw new Error(`bad hour range: ${s}`);
      return { start, end };
    });
}

export function inRanges(hour: number, ranges: HourRange[]): boolean {
  return ranges.some((r) => (r.start < r.end ? hour >= r.start && hour < r.end : hour >= r.start || hour < r.end));
}

function kw(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(env: Env): Config {
  return {
    title: String(env.SITE_TITLE ?? ""),
    tz: String(env.TIMEZONE || "UTC"),
    offpeak: parseHourRanges(String(env.OFFPEAK_HOURS ?? "")),
    powerUnit: String(env.DEYE_POWER_UNIT) === "kW" ? "kW" : "W",
    stationName: String(env.STATION_NAME ?? ""),
    backfillFrom: String(env.BACKFILL_FROM ?? ""),
    gauges: {
      pv: kw(env.GAUGE_PV_KW, 5),
      grid: kw(env.GAUGE_GRID_KW, 12),
      battery: kw(env.GAUGE_BATTERY_KW, 5),
      load: kw(env.GAUGE_LOAD_KW, 12),
    },
    allowPublic: String(env.ALLOW_PUBLIC) === "true",
  };
}
