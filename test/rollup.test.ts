import { describe, expect, it } from "vitest";
import { parseHourRanges } from "../worker/config";
import { parseTs, toReading } from "../worker/ingest";
import { findGaps, rollupDay, type Reading } from "../worker/rollup";
import { dayStart } from "../worker/time";

const cfg = { tz: "Europe/Warsaw", offpeak: parseHourRanges("22-6,13-15") };
const day = "2026-07-10";
const start = dayStart(day, cfg.tz);

function row(offsetMin: number, p: Partial<Reading>): Reading {
  return { ts: start + offsetMin * 60, pv_kw: null, load_kw: null, grid_kw: null, battery_kw: null, soc: null, ...p };
}

describe("rollupDay", () => {
  it("integrates kW over 5 minute samples", () => {
    const rows = [0, 5, 10, 15].map((m) => row(m, { pv_kw: 1.2, load_kw: 0.6 }));
    rows.push(row(20, { pv_kw: 0 }));
    const d = rollupDay(day, rows, cfg);
    expect(d.pv_kwh).toBeCloseTo(1.2 * (20 / 60), 6);
    expect(d.load_kwh).toBeCloseTo(0.6 * (20 / 60), 6);
    expect(d.samples).toBe(5);
  });

  it("caps gaps at 10 minutes", () => {
    const rows = [row(0, { pv_kw: 3 }), row(60, { pv_kw: 3 })];
    const d = rollupDay(day, rows, cfg);
    // first sample: gap 60 min capped to 10; last sample: nominal 5 min
    expect(d.pv_kwh).toBeCloseTo(3 * (10 / 60) + 3 * (5 / 60), 6);
  });

  it("splits grid import by zone and export separately", () => {
    // local 00:00 is offpeak, 08:00 is peak
    const rows = [row(0, { grid_kw: 2 }), row(8 * 60, { grid_kw: 1 }), row(8 * 60 + 5, { grid_kw: -3 })];
    const d = rollupDay(day, rows, cfg);
    expect(d.import_offpeak_kwh).toBeCloseTo(2 / 6, 6); // gap to next sample capped at 10 min
    expect(d.import_peak_kwh).toBeCloseTo(1 / 12, 6);
    expect(d.export_kwh).toBeCloseTo(3 / 12, 6);
  });

  it("splits battery charge and discharge, tracks soc range", () => {
    const rows = [row(0, { battery_kw: -2, soc: 40 }), row(5, { battery_kw: 1, soc: 55 }), row(10, { battery_kw: 0, soc: 50 })];
    const d = rollupDay(day, rows, cfg);
    expect(d.batt_charge_kwh).toBeCloseTo(2 / 12, 6);
    expect(d.batt_discharge_kwh).toBeCloseTo(1 / 12, 6);
    expect(d.soc_min).toBe(40);
    expect(d.soc_max).toBe(55);
  });

  it("counts every sample of the 25 hour day when DST ends", () => {
    const dst = "2026-10-25";
    const s = dayStart(dst, cfg.tz);
    const rows: Reading[] = [];
    for (let t = s; t < s + 25 * 3600; t += 300) rows.push({ ...row(0, { pv_kw: 1 }), ts: t });
    const d = rollupDay(dst, rows, cfg);
    expect(d.samples).toBe(300);
    expect(d.pv_kwh).toBeCloseTo(25, 6);
  });

  it("uses the first sample of the next day to close the last interval, but does not count it", () => {
    const rows = [row(24 * 60 - 5, { pv_kw: 6 }), row(24 * 60, { pv_kw: 6 })];
    const d = rollupDay(day, rows, cfg);
    expect(d.samples).toBe(1);
    expect(d.pv_kwh).toBeCloseTo(6 / 12, 6);
  });
});

describe("toReading", () => {
  // Real frames from a Deye hybrid inverter: watts, signed batteryPower, grid magnitude only.
  it("night grid charging: import, battery charging", () => {
    const r = toReading(
      { timeStamp: 1792616700, generationPower: 0, consumptionPower: 121, gridPower: null, purchasePower: 2798, wirePower: 2798, batteryPower: -2580, chargePower: -2580, dischargePower: null, batterySOC: 83 },
      "W",
    )!;
    expect(r.pv_kw).toBe(0);
    expect(r.load_kw).toBeCloseTo(0.121);
    expect(r.grid_kw).toBeCloseTo(2.798);
    expect(r.battery_kw).toBeCloseTo(-2.58);
    expect(r.soc).toBe(83);
  });
  it("evening: battery discharging covers the load", () => {
    const r = toReading(
      { timeStamp: 1792608600, generationPower: 0, consumptionPower: 48, purchasePower: 14, wirePower: 14, batteryPower: 129, dischargePower: 129, batterySOC: 48 },
      "W",
    )!;
    expect(r.battery_kw).toBeCloseTo(0.129);
    expect(r.grid_kw).toBeCloseTo(-0.014); // surplus after losses, counted as export
  });
  it("sunny day with a full battery: export", () => {
    const r = toReading({ timeStamp: 1792600000, generationPower: 4200, consumptionPower: 600, purchasePower: 3500, wirePower: 3500, batteryPower: 0, batterySOC: 100 }, "W")!;
    expect(r.grid_kw).toBeCloseTo(-3.5);
  });
  it("falls back to signed grid, charge/discharge pair and kW unit", () => {
    const r = toReading({ timeStamp: "1760000000000", gridPower: -1.2, chargePower: -0.5, dischargePower: null }, "kW")!;
    expect(r.ts).toBe(1760000000);
    expect(r.battery_kw).toBeCloseTo(-0.5);
    expect(r.grid_kw).toBeCloseTo(1.2); // load 0, pv 0, battery charging 0.5 -> net positive -> import
  });
  it("drops empty frames and bad timestamps", () => {
    expect(toReading({ timeStamp: 1760000000 }, "W")).toBeNull();
    expect(toReading({ generationPower: 1 }, "W")).toBeNull();
  });
  it("parses timestamp shapes", () => {
    expect(parseTs(1760000000)).toBe(1760000000);
    expect(parseTs("1760000000000")).toBe(1760000000);
    expect(parseTs("2026-07-10T10:00:00Z")).toBe(Date.parse("2026-07-10T10:00:00Z") / 1000);
    expect(parseTs("nope")).toBeNull();
  });
});

describe("findGaps", () => {
  const end = start + 3600;
  it("finds nothing in a complete hour", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i * 5, {}));
    expect(findGaps(rows, start, end)).toEqual([]);
  });
  it("reports leading, middle and trailing gaps", () => {
    const rows = [row(15, {}), row(20, {}), row(40, {})];
    expect(findGaps(rows, start, end)).toEqual([
      { start, end: start + 15 * 60 },
      { start: start + 25 * 60, end: start + 40 * 60 },
      { start: start + 45 * 60, end },
    ]);
  });
  it("reports a single missing frame", () => {
    const rows = [row(0, {}), row(10, {}), row(15, {})];
    expect(findGaps(rows, start, start + 20 * 60)).toEqual([{ start: start + 5 * 60, end: start + 10 * 60 }]);
  });
  it("ignores timestamp jitter", () => {
    const rows = [row(0, {}), row(5.5, {}), row(10, {})];
    expect(findGaps(rows, start, start + 15 * 60)).toEqual([]);
  });
  it("whole range empty is one gap", () => {
    expect(findGaps([], start, end)).toEqual([{ start, end }]);
  });
});
