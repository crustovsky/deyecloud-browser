// Daily energy totals from 5 minute power samples. Pure, no I/O.

import type { Config } from "./config";
import { dayEnd, dayStart, zoneFor } from "./time";

export interface Reading {
  ts: number;
  pv_kw: number | null;
  load_kw: number | null;
  grid_kw: number | null; // positive = import, negative = export
  battery_kw: number | null; // positive = discharging, negative = charging
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
}

// A sample represents power until the next sample. Gaps longer than this count
// as missing data rather than being stretched, so outages do not inflate totals.
export const MAX_GAP_S = 600;
const NOMINAL_GAP_S = 300;

// `rows` must be sorted by ts ascending and may include readings after the day
// ends; those only close the last interval of the day.
export function rollupDay(day: string, rows: Reading[], cfg: Pick<Config, "tz" | "offpeak">): Daily {
  const start = dayStart(day, cfg.tz);
  const end = dayEnd(day, cfg.tz);
  const d: Daily = {
    day,
    pv_kwh: 0,
    load_kwh: 0,
    import_peak_kwh: 0,
    import_offpeak_kwh: 0,
    export_kwh: 0,
    batt_charge_kwh: 0,
    batt_discharge_kwh: 0,
    soc_min: null,
    soc_max: null,
    samples: 0,
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.ts < start || r.ts >= end) continue;
    d.samples++;

    const next = rows[i + 1]?.ts ?? r.ts + NOMINAL_GAP_S;
    const h = Math.min(Math.max(next - r.ts, 0), MAX_GAP_S) / 3600;

    d.pv_kwh += (r.pv_kw ?? 0) * h;
    d.load_kwh += (r.load_kw ?? 0) * h;

    const grid = r.grid_kw ?? 0;
    if (grid > 0) {
      if (zoneFor(r.ts, cfg.tz, cfg.offpeak) === "peak") d.import_peak_kwh += grid * h;
      else d.import_offpeak_kwh += grid * h;
    } else {
      d.export_kwh += -grid * h;
    }

    const batt = r.battery_kw ?? 0;
    if (batt > 0) d.batt_discharge_kwh += batt * h;
    else d.batt_charge_kwh += -batt * h;

    if (r.soc != null) {
      d.soc_min = d.soc_min == null ? r.soc : Math.min(d.soc_min, r.soc);
      d.soc_max = d.soc_max == null ? r.soc : Math.max(d.soc_max, r.soc);
    }
  }
  return d;
}
