#!/usr/bin/env node
// Runs wrangler with wrangler.local.jsonc when that file exists, otherwise with
// the committed wrangler.jsonc. The local file is gitignored and holds your own
// database id, title, backfill date, domain and so on.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const config = existsSync("wrangler.local.jsonc") ? "wrangler.local.jsonc" : "wrangler.jsonc";
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/wrangler.mjs <wrangler args>");
  process.exit(2);
}
console.log(`[wrangler] using ${config}`);
const res = spawnSync("npx", ["wrangler", "--config", config, ...args], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(res.status ?? 1);
