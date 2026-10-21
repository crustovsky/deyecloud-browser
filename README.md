# Deye Cloud browser

A small, self-hosted energy dashboard for Deye hybrid inverters. A Cloudflare Worker pulls 5 minute history from the Deye Cloud OpenAPI, keeps it in D1 for as long as you like, and serves a few static pages: a live power flow, a day chart with tariff zones, daily totals split by tariff zone, and battery throughput. Read-only against Deye; the app never changes inverter settings.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/crustovsky/deyecloud-browser)

- **Live**: four gauges (solar, grid, battery, house) with animated flow wires, like the inverter's own panel, today's totals and a Fetch now button
- **Day**: PV, house, grid and battery power for any day, SOC underneath, peak tariff hours shaded
- **Totals**: energy per day, grid import split into peak and off-peak, self-sufficiency, with a table
- **Battery**: daily charge and discharge, round trip, lowest SOC per day
- Private by default: only visitors authenticated by [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) see anything
- Runs inside the free tiers of Workers and D1; about 9,000 Deye API calls a month

## Before you deploy

1. Create a Deye Cloud developer app at [developer.deyecloud.com](https://developer.deyecloud.com) and note the **App ID** and **App Secret**. Grant it station monitoring; device monitoring is harmless; no control permissions are needed.
2. Your Deye Cloud account email and password. The Worker hashes the password with SHA-256 before sending it, as the API requires.
3. Find your region's API host. EU accounts use `https://eu1-developer.deyecloud.com`.

## Deploy

### With the Deploy to Cloudflare button

The button forks this repository into your GitHub or GitLab account, creates the D1 database, builds the site and deploys the Worker to a `*.workers.dev` address. Every push to the new repository redeploys it. On the setup screen, set the variables listed under [Configuration](#configuration); the defaults suit a Polish G12 tariff.

After the deploy:

1. Add the four secrets under the Worker's **Settings → Variables and Secrets**: `DEYE_APP_ID`, `DEYE_APP_SECRET`, `DEYE_EMAIL`, `DEYE_PASSWORD`.
2. [Turn on Cloudflare Access](#turn-on-cloudflare-access). Until you do, the Worker only shows a "This dashboard is private" page.
3. Wait for the cron (every 5 minutes). The first runs backfill history from `BACKFILL_FROM` at six days per run. The footer shows progress.

### Manually

```sh
git clone https://github.com/crustovsky/deyecloud-browser && cd deyecloud-browser
npm install
npx wrangler login
npx wrangler d1 create deyecloud-browser     # paste the database_id into wrangler.jsonc
npx wrangler secret put DEYE_APP_ID
npx wrangler secret put DEYE_APP_SECRET
npx wrangler secret put DEYE_EMAIL
npx wrangler secret put DEYE_PASSWORD
npm run deploy
```

The Worker creates its tables on first use; there is no migration step.

## Turn on Cloudflare Access

1. In the dashboard go to **Workers & Pages** and select the Worker.
2. Open the **Access** tab and select **Protect this Worker behind Access**.
3. Change the scope to **All traffic**. The default, **Previews only**, leaves the main address unprotected.
4. Under **Authentication policy**, choose who may sign in: your Cloudflare account members, specific emails, or an email domain.
5. Select **Apply Access**.

If you really want a public dashboard, set `ALLOW_PUBLIC` to `true`.

## Configuration

Variables in `wrangler.jsonc` (or the Worker's **Settings → Variables**):

| Variable           | Default                                | Meaning |
| ------------------ | -------------------------------------- | ------- |
| `ALLOW_PUBLIC`     | `false`                                | `true` serves visitors without Cloudflare Access. |
| `SITE_TITLE`       | (empty)                                | Name in the top bar. Empty uses the plant name from Deye Cloud. |
| `DEYE_BASE_URL`    | `https://eu1-developer.deyecloud.com`  | OpenAPI host for your region. |
| `DEYE_POWER_UNIT`  | `W`                                    | Unit of power values from the API, `W` or `kW`. If PV reads 1000x off, flip it and re-run the backfill (see below). |
| `STATION_NAME`     | (empty)                                | Plant name, only if the account has several. Empty picks the first. |
| `BACKFILL_FROM`    | (empty)                                | First day of history to fetch, `YYYY-MM-DD`. Empty means the last 30 days. |
| `TIMEZONE`         | `Europe/Warsaw`                        | IANA timezone of the plant: day boundaries and tariff zones follow it. |
| `OFFPEAK_HOURS`    | `22-6,13-15`                           | Cheap tariff hours, local time, `start-end` ranges separated by commas. Empty means a flat tariff (everything counts as peak). |
| `GAUGE_PV_KW`      | `5`                                    | Full scale of the solar gauge, usually the array size in kWp. |
| `GAUGE_GRID_KW`    | `12`                                   | Full scale of the grid gauge. |
| `GAUGE_BATTERY_KW` | `5`                                    | Full scale of the battery gauge. |
| `GAUGE_LOAD_KW`    | `12`                                   | Full scale of the house gauge. |

Secrets: `DEYE_APP_ID`, `DEYE_APP_SECRET`, `DEYE_EMAIL`, `DEYE_PASSWORD`.

### Checking units and signs

Deye's spec does not state units or sign conventions. Before trusting totals, run the probe once from your machine:

```sh
cp .dev.vars.example .dev.vars    # fill in the four secrets
npm run probe
```

It prints the raw station list, latest data and a few history frames with notes on what to look for. The dashboard uses: grid positive = import, battery positive = discharging, matching the Deye web export.

To re-run the backfill after changing `DEYE_POWER_UNIT` or `BACKFILL_FROM`, delete the cursor:

```sh
npx wrangler d1 execute deyecloud-browser --remote --command "DELETE FROM meta WHERE key = 'cursor'"
```

Existing rows are overwritten in place, so nothing is duplicated.

## How it works

- **Cron every 5 minutes** fetches `station/history/power` from 15 minutes before the stored cursor to now, upserts readings on timestamp and recomputes daily totals for the days touched. The same loop does the initial backfill in day-sized chunks, a few per run.
- **Daily totals** are integrated from the 5 minute samples in the Worker (energy = kW × gap to the next sample, gaps capped at 10 minutes). Tariff zone is assigned in local time, so DST changes are handled.
- **Rate limits**: on HTTP 429 or 5xx the Worker stops, honours `Retry-After` or backs off exponentially up to 30 minutes, and resumes on the next cron. Calls per day and any rate limit headers are visible at `/api/status`.
- **API** (same origin, behind Access): `/api/config`, `/api/status`, `/api/latest`, `/api/day?date=`, `/api/daily?from=&to=`, `POST /api/ingest?chunks=` for a manual run (at most once a minute).

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars    # fill in the secrets
npm run dev                       # builds the site, then wrangler dev with a local D1
```

Then `curl -X POST localhost:8787/api/ingest?chunks=30` to fill the local database. `npm test` runs the unit tests for zone assignment, DST day boundaries and the energy integration.

## License

[MIT](LICENSE)
