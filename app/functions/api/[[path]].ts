/**
 * Cloudflare Pages Function: the site's own /api/*, forwarded to the FIRE//WATCH data server
 * running as a Databricks App. See DEPLOY-DATABRICKS.md.
 *
 * This hop exists because a Databricks app can't be reached anonymously — every request needs
 * an OAuth token, and a browser can't hold one (a cross-origin fetch can't follow the login
 * redirect, and putting the client secret in front-end JavaScript would publish it). So the
 * credential lives here, in Pages' encrypted environment variables, and the browser only ever
 * talks to its own origin.
 *
 * Built so the data server's caching still works end to end: `if-none-match` goes up and
 * `etag` comes back, so a device that already has the latest copy still gets a bodyless 304.
 *
 * Environment (Pages → Settings → Variables and Secrets):
 *   DATABRICKS_HOST           https://dbc-….cloud.databricks.com
 *   DATABRICKS_APP_URL        https://<app>-<id>.<region>.databricksapps.com
 *   DATABRICKS_CLIENT_ID      service principal (plaintext is fine)
 *   DATABRICKS_CLIENT_SECRET  service principal (mark as a secret)
 */
interface Env {
  DATABRICKS_HOST: string;
  DATABRICKS_APP_URL: string;
  DATABRICKS_CLIENT_ID: string;
  DATABRICKS_CLIENT_SECRET: string;
  /** Local testing escape hatch; see accessToken(). */
  DATABRICKS_TOKEN?: string;
}

/**
 * Workspace tokens last about an hour. Holding one at module scope reuses it for every request
 * an isolate serves; a cold isolate just mints another, so this needs no KV namespace.
 */
let cached: { token: string; expires: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  // Local testing only: `wrangler pages dev` with a token from `databricks auth token`, so the
  // forwarding below can be exercised without a service principal. No use in production — app
  // tokens last about an hour. Note that a personal access token will NOT work here: Databricks
  // Apps reject PATs with 401 and accept only OAuth tokens.
  if (env.DATABRICKS_TOKEN) return env.DATABRICKS_TOKEN;
  const now = Date.now();
  // Renew a minute early, so a token can't expire mid-flight.
  if (cached && cached.expires > now + 60_000) return cached.token;
  const res = await fetch(`${env.DATABRICKS_HOST.replace(/\/+$/, "")}/oidc/v1/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.DATABRICKS_CLIENT_ID}:${env.DATABRICKS_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!res.ok) throw new Error(`Databricks token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expires: now + body.expires_in * 1000 };
  return cached.token;
}

export async function onRequestGet(ctx: { request: Request; env: Env }): Promise<Response> {
  const url = new URL(ctx.request.url);
  let token: string;
  try {
    token = await accessToken(ctx.env);
  } catch (e) {
    // The map keeps working without the data server, so say what happened and don't pretend.
    return Response.json({ error: `Data server unreachable: ${String(e)}` }, { status: 502 });
  }

  const headers = new Headers({ Authorization: `Bearer ${token}` });
  const etag = ctx.request.headers.get("if-none-match");
  if (etag) headers.set("If-None-Match", etag);

  const res = await fetch(`${ctx.env.DATABRICKS_APP_URL.replace(/\/+$/, "")}${url.pathname}${url.search}`, { headers });

  // Pass through only what the browser needs. Not content-encoding or content-length: the
  // runtime has already decompressed the body, so repeating them would describe it wrongly.
  const out = new Headers();
  for (const h of ["content-type", "etag", "x-fetched-at", "cache-control"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.status === 304 ? null : res.body, { status: res.status, headers: out });
}
