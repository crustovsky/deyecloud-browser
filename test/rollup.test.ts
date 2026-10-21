import { describe, expect, it } from "vitest";
import { parseHourRanges } from "../worker/config";
import { parseTs, toReading } from "../worker/ingest";
import { rollupDay, type Reading } from "../worker/rollup";
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

  it("uses the first sample of the next day to close the last interval, but does not count it", () => {
    const rows = [row(24 * 60 - 5, { pv_kw: 6 }), row(24 * 60, { pv_kw: 6 })];
    const d = rollupDay(day, rows, cfg);
    expect(d.samples).toBe(1);
    expect(d.pv_kwh).toBeCloseTo(6 / 12, 6);
  });
});

describe("toReading", () => {
  it("converts watts and prefers unsigned pairs", () => {
    const r = toReading(
      { timeStamp: 1760000000, generationPower: 1500, consumptionPower: 700, purchasePower: 0, wirePower: 800, chargePower: 600, dischargePower: 0, batterySOC: 77 },
      "W",
    )!;
    expect(r.pv_kw).toBeCloseTo(1.5);
    expect(r.load_kw).toBeCloseTo(0.7);
    expect(r.grid_kw).toBeCloseTo(-0.8);
    expect(r.battery_kw).toBeCloseTo(-0.6);
    expect(r.soc).toBe(77);
  });
  it("falls back to signed fields and kW unit", () => {
    const r = toReading({ timeStamp: "1760000000000", gridPower: 1.2, batteryPower: -0.5 }, "kW")!;
    expect(r.ts).toBe(1760000000);
    expect(r.grid_kw).toBeCloseTo(1.2);
    expect(r.battery_kw).toBeCloseTo(-0.5);
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
