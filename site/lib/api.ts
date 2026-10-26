export interface Reading {
  ts: number;
  pv_kw: number | null;
  load_kw: number | null;
  grid_kw: number | null;
  battery_kw: number | null;
  soc: number | null;
}

export interface Daily {
  day: string;
  pv_kwh: number;
  load_kwh: number;
  import_peak_kwh: number;
  import_offpeak_kwh: number;
  export_kwh: number;
  batt_charge_kwh: number;
  batt_discharge_kwh: number;
  soc_min: number | null;
  soc_max: number | null;
  samples: number;
  missing_min?: number; // minutes of the day without a sample, from /api/daily
}

export interface AppConfig {
  title: string;
  stationName: string;
  timezone: string;
  offpeak: { start: number; end: number }[];
  gauges: { pv: number; grid: number; battery: number; load: number };
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export function kw(v: number | null | undefined, digits = 2): string {
  return v == null ? "–" : v.toFixed(digits);
}

export function kwh(v: number | null | undefined): string {
  return v == null ? "–" : v.toFixed(1);
}

export function timeAgo(ts: number, now = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - ts);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Today's date in a given IANA timezone, YYYY-MM-DD.
export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function qs(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

export function setQs(params: Record<string, string>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  history.replaceState(null, "", u);
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
