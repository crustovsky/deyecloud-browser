#!/usr/bin/env node
// Calls the Deye Cloud API once with the credentials from .dev.vars and prints raw
// responses, so you can confirm units, signs and timestamp format before trusting
// any totals. Read-only. Uses 4 API calls.
//
//   npm run probe

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const vars = {};
try {
  for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) vars[m[1]] = m[2];
  }
} catch {
  console.error("Create .dev.vars from .dev.vars.example first.");
  process.exit(1);
}
const env = { ...vars, ...process.env };
const base = env.DEYE_BASE_URL || "https://eu1-developer.deyecloud.com";
for (const k of ["DEYE_APP_ID", "DEYE_APP_SECRET", "DEYE_EMAIL", "DEYE_PASSWORD"]) {
  if (!env[k]) {
    console.error(`Missing ${k}`);
    process.exit(1);
  }
}

async function post(path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const limits = [...res.headers].filter(([k]) => /ratelimit|rate-limit|retry-after/i.test(k));
  if (limits.length) console.log("rate limit headers:", Object.fromEntries(limits));
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const password = createHash("sha256").update(env.DEYE_PASSWORD).digest("hex");
const tok = await post(`/v1.0/account/token?appId=${encodeURIComponent(env.DEYE_APP_ID)}`, {
  appSecret: env.DEYE_APP_SECRET,
  email: env.DEYE_EMAIL,
  password,
});
console.log(`token ok, expires in ${Math.round(Number(tok.expiresIn) / 86400)} days`);
const token = tok.accessToken.replace(/^Bearer\s+/i, "");

const stations = await post("/v1.0/station/list", { page: 1, size: 50 }, token);
console.log("\n== station/list");
console.log(JSON.stringify(stations.stationList, null, 2));
const station = (env.STATION_NAME && stations.stationList.find((s) => s.name === env.STATION_NAME)) || stations.stationList[0];
if (!station) throw new Error("no stations");

console.log(`\n== station/latest (${station.name}, id ${station.id})`);
const latest = await post("/v1.0/station/latest", { stationId: station.id }, token);
console.log(JSON.stringify(latest, null, 2));

const now = Math.floor(Date.now() / 1000);
console.log("\n== station/history/power (last 30 minutes)");
const hist = await post("/v1.0/station/history/power", { stationId: station.id, startTimestamp: now - 1800, endTimestamp: now }, token);
console.log(JSON.stringify(hist, null, 2));

console.log(`
Check:
  1. generationPower during daylight: hundreds to thousands means W (DEYE_POWER_UNIT=W), single digits means kW.
  2. purchasePower / wirePower and chargePower / dischargePower present and non-negative? Then signs are handled.
     If only gridPower / batteryPower exist, note their sign while importing or charging and compare with the dashboard.
  3. timeStamp: unix seconds, milliseconds, or a date string? All three are parsed; a string without a timezone is read as UTC.
  4. regionTimezone of the station should match the TIMEZONE variable.`);
