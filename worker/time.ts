// Local-time helpers. Timestamps are unix seconds (UTC) everywhere; local time
// is only used for day boundaries and tariff zones.

import { inRanges, type HourRange } from "./config";

export type Zone = "peak" | "offpeak";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatters.set(tz, f);
  }
  return f;
}

// Intl formatting costs a few microseconds per call, which adds up to the whole
// CPU budget of a Workers free plan invocation when done per sample. Offsets only
// change at DST transitions, so they are cached per 30 minute bucket instead.
const OFFSET_BUCKET_S = 1800;
const offsets = new Map<string, number>();

// Offset of local time from UTC at the given instant, in seconds.
function offsetAt(ts: number, tz: string): number {
  const bucket = Math.floor(ts / OFFSET_BUCKET_S) * OFFSET_BUCKET_S;
  const key = `${tz}:${bucket}`;
  let off = offsets.get(key);
  if (off == null) {
    const parts = formatter(tz).formatToParts(new Date(bucket * 1000));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    off = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute")) / 1000 - bucket;
    if (offsets.size > 10000) offsets.clear();
    offsets.set(key, off);
  }
  return off;
}

export interface LocalParts {
  day: string; // YYYY-MM-DD
  hour: number;
  minute: number;
}

const dayNames = new Map<number, string>();

function dayName(dayNumber: number): string {
  let name = dayNames.get(dayNumber);
  if (!name) {
    name = new Date(dayNumber * 86400 * 1000).toISOString().slice(0, 10);
    if (dayNames.size > 10000) dayNames.clear();
    dayNames.set(dayNumber, name);
  }
  return name;
}

export function localParts(ts: number, tz: string): LocalParts {
  const local = ts + offsetAt(ts, tz);
  const secs = ((local % 86400) + 86400) % 86400;
  return {
    day: dayName(Math.floor(local / 86400)),
    hour: Math.floor(secs / 3600),
    minute: Math.floor((secs % 3600) / 60),
  };
}

export function zoneFor(ts: number, tz: string, offpeak: HourRange[]): Zone {
  return inRanges(localParts(ts, tz).hour, offpeak) ? "offpeak" : "peak";
}

export function localDay(ts: number, tz: string): string {
  return localParts(ts, tz).day;
}

// Unix seconds of local midnight that starts the given day.
// DST transitions in Europe happen at 01:00 UTC or later, never at local midnight,
// so a single correction pass is enough.
export function dayStart(day: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const start = guess - offsetAt(guess, tz);
  return guess - offsetAt(start, tz);
}

export function dayEnd(day: string, tz: string): number {
  return dayStart(addDays(day, 1), tz);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
