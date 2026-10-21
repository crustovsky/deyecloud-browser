import { handleApi } from "./api";
import { loadConfig } from "./config";
import { runIngest } from "./ingest";
import { ensureSchema } from "./schema";
import { serveSite } from "./site";

const CRON_CHUNKS = 6;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cfg = loadConfig(env);

    // Private by default: only serve requests that Cloudflare Access authenticated.
    if (!ctx.access && !cfg.allowPublic) return accessRequired();

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        await ensureSchema(env.DB);
        return await handleApi(request, env, cfg);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ message: "api error", path: url.pathname, error }));
        return new Response(JSON.stringify({ error }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    return serveSite(request);
  },

  async scheduled(_controller, env): Promise<void> {
    const cfg = loadConfig(env);
    await ensureSchema(env.DB);
    const result = await runIngest(env, cfg, "cron", CRON_CHUNKS);
    console.log(JSON.stringify({ message: "ingest", ...result }));
  },
} satisfies ExportedHandler<Env>;

function accessRequired(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#222}code{background:#eee;padding:.1em .3em;border-radius:3px}.muted{color:#666}</style>
</head><body>
<h1>This dashboard is private</h1>
<p>Cloudflare Access is not protecting this address yet, so nothing is shown.</p>
<h2>If you deployed this Worker, turn Access on</h2>
<p>Workers &amp; Pages → <em>this Worker</em> → <strong>Access</strong> tab → <strong>Protect this Worker behind Access</strong> → <strong>All traffic</strong> (the default, Previews only, is not enough), choose who may sign in, then <strong>Apply Access</strong>.</p>
<p class="muted">To make the dashboard public on purpose, set the <code>ALLOW_PUBLIC</code> variable to <code>true</code>.</p>
</body></html>`;
  return new Response(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
}
