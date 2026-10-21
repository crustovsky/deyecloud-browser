import { describe, expect, it } from "vitest";
import { parseHourRanges, inRanges } from "../worker/config";
import { addDays, dayEnd, dayStart, localDay, zoneFor } from "../worker/time";

const TZ = "Europe/Warsaw";
const G12 = parseHourRanges("22-6,13-15");
const utc = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("hour ranges", () => {
  it("parses and wraps past midnight", () => {
    expect(G12).toEqual([
      { start: 22, end: 6 },
      { start: 13, end: 15 },
    ]);
    expect(inRanges(23, G12)).toBe(true);
    expect(inRanges(5, G12)).toBe(true);
    expect(inRanges(6, G12)).toBe(false);
    expect(inRanges(13, G12)).toBe(true);
    expect(inRanges(15, G12)).toBe(false);
    expect(inRanges(12, G12)).toBe(false);
    expect(inRanges(12, [])).toBe(false);
  });
  it("rejects nonsense", () => {
    expect(() => parseHourRanges("25-3")).toThrow();
    expect(() => parseHourRanges("abc")).toThrow();
  });
});

describe("day boundaries in Europe/Warsaw", () => {
  it("summer day starts at 22:00 UTC the evening before", () => {
    expect(dayStart("2026-07-10", TZ)).toBe(utc("2026-07-09T22:00:00Z"));
    expect(dayEnd("2026-07-10", TZ)).toBe(utc("2026-07-10T22:00:00Z"));
  });
  it("winter day starts at 23:00 UTC", () => {
    expect(dayStart("2026-01-10", TZ)).toBe(utc("2026-01-09T23:00:00Z"));
  });
  it("DST end day (2026-10-25) is 25 hours long", () => {
    const start = dayStart("2026-10-25", TZ);
    expect(start).toBe(utc("2026-10-24T22:00:00Z"));
    expect(dayEnd("2026-10-25", TZ) - start).toBe(25 * 3600);
  });
  it("DST start day (2026-03-29) is 23 hours long", () => {
    const start = dayStart("2026-03-29", TZ);
    expect(start).toBe(utc("2026-03-28T23:00:00Z"));
    expect(dayEnd("2026-03-29", TZ) - start).toBe(23 * 3600);
  });
  it("localDay follows the local date", () => {
    expect(localDay(utc("2026-07-09T22:30:00Z"), TZ)).toBe("2026-07-10");
    expect(localDay(utc("2026-07-09T21:30:00Z"), TZ)).toBe("2026-07-09");
  });
  it("addDays crosses months", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("zones", () => {
  it("assigns zones in local time across DST", () => {
    // Summer: 12:30 UTC = 14:30 CEST, offpeak; 13:30 UTC = 15:30 CEST, peak.
    expect(zoneFor(utc("2026-07-10T12:30:00Z"), TZ, G12)).toBe("offpeak");
    expect(zoneFor(utc("2026-07-10T13:30:00Z"), TZ, G12)).toBe("peak");
    // Winter: 13:30 UTC = 14:30 CET, offpeak.
    expect(zoneFor(utc("2026-01-10T13:30:00Z"), TZ, G12)).toBe("offpeak");
    expect(zoneFor(utc("2026-01-10T21:30:00Z"), TZ, G12)).toBe("offpeak"); // 22:30 CET
    expect(zoneFor(utc("2026-01-10T20:30:00Z"), TZ, G12)).toBe("peak"); // 21:30 CET
  });
  it("flat tariff is all peak", () => {
    expect(zoneFor(utc("2026-01-10T23:30:00Z"), TZ, [])).toBe("peak");
  });
});
