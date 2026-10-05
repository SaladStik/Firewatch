/**
 * Cloudflare Pages Function: firefighting aircraft in the air now, for a deployment with no
 * data server behind it.
 *
 * Every other live source the map uses sends `access-control-allow-origin: *`, so a browser can
 * fetch it itself. ADS-B is the exception — adsb.lol, opendata.adsb.fi and airplanes.live all
 * answer a request but send no CORS header, and OpenSky allows only its own origin, so no amount
 * of client-side work gets aircraft into a page. It needs something server-side.
 *
 * It does not need the *data server*, though: this runs at the edge with the Pages deployment,
 * and adsb.lol needs no credential, so there is nothing to configure. It takes precedence over
 * the [[path]] catch-all next to it, which would otherwise try to forward /api/aircraft to the
 * data server.
 *
 * Answers are cached for the same two minutes the data server used, so a room full of browsers
 * costs a community-run service one sweep rather than one each.
 */
import { fetchFireAircraft } from "../../src/data/aircraft";

/** Matches the data server's refresh interval for this source. */
const TTL_SECONDS = 120;

export async function onRequestGet(ctx: { request: Request }): Promise<Response> {
  const key = new Request(new URL("/api/aircraft", ctx.request.url).toString(), { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;

  let body: unknown;
  try {
    body = await fetchFireAircraft();
  } catch (e) {
    // The map treats a failure here as "no aircraft layer" and carries on, so say so plainly
    // and don't cache it — the next request should try again.
    return Response.json({ error: `Aircraft unavailable: ${String(e)}` }, { status: 502 });
  }

  const res = Response.json(body, {
    headers: { "cache-control": `public, max-age=${TTL_SECONDS}`, "access-control-allow-origin": "*" },
  });
  await cache.put(key, res.clone());
  return res;
}
