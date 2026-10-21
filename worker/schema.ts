// Created by the Worker itself on first use, so a one-click deploy needs no migration step.
// Every statement is idempotent.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS readings (
    ts INTEGER PRIMARY KEY,
    pv_kw REAL,
    load_kw REAL,
    grid_kw REAL,
    battery_kw REAL,
    soc REAL
  )`,
  `CREATE TABLE IF NOT EXISTS daily (
    day TEXT PRIMARY KEY,
    pv_kwh REAL,
    load_kwh REAL,
    import_peak_kwh REAL,
    import_offpeak_kwh REAL,
    export_kwh REAL,
    batt_charge_kwh REAL,
    batt_discharge_kwh REAL,
    soc_min REAL,
    soc_max REAL,
    samples INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = db.batch(SCHEMA.map((s) => db.prepare(s))).then(() => undefined);
    ready.catch(() => (ready = null));
  }
  return ready;
}
