// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Set them with `wrangler secret put <NAME>` or in the dashboard.
interface Env {
  DEYE_APP_ID: string;
  DEYE_APP_SECRET: string;
  DEYE_EMAIL: string;
  DEYE_PASSWORD: string;
}
