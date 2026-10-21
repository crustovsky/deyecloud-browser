// Serves the embedded Astro build. See scripts/bundle-site.mjs for why the site
// ships inside the Worker instead of using Workers static assets.

import { SITE, type SiteFile } from "./site.generated";

function body(file: SiteFile): BodyInit {
  if (file.text != null) return file.text;
  const bin = atob(file.base64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function lookup(pathname: string): SiteFile | undefined {
  let p = pathname.replace(/\/+$/, "") || "/index.html";
  if (p === "/") p = "/index.html";
  return SITE[p] ?? SITE[`${p}.html`] ?? SITE[`${p}/index.html`];
}

export function serveSite(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const url = new URL(request.url);
  const file = lookup(url.pathname);
  const headers = new Headers();
  if (!file) {
    const nf = SITE["/404.html"];
    headers.set("content-type", nf?.type ?? "text/plain; charset=utf-8");
    return new Response(nf ? body(nf) : "Not found", { status: 404, headers });
  }
  headers.set("content-type", file.type);
  // Astro puts a content hash into /_astro/ file names, so those can be cached hard.
  headers.set("cache-control", url.pathname.startsWith("/_astro/") ? "public, max-age=31536000, immutable" : "no-cache");
  return new Response(request.method === "HEAD" ? null : body(file), { headers });
}
