/**
 * FIRE//WATCH data server.
 *
 *   npm run server                       (http://localhost:8787)
 *
 * Fetches the live sources the website would otherwise fetch from every visitor's browser —
 * Open-Meteo weather (+ the FWI System), CWFIS hotspots / perimeters / fire weather stations and
 * each fire's growth history — once per refresh window, caches them in memory and on disk
 * (server/.cache, survives restarts) and serves the same copy to everyone. When a source fails
 * or rate-limits, the last good copy keeps being served.
 *
 * The website uses it when started with VITE_DATA_SERVER set to this server's address
 * (see src/data/liveData.ts); otherwise it fetches the sources itself, as before.
 * If a built site exists in dist/, it's served too (one process for everything).
 *
 * Environment:
 *   PORT                 port to listen on (default 8787)
 *   FIREWATCH_PREWARM    regions kept fresh in the background, comma-separated region ids
 *                        (default "alberta"; others are fetched when first requested)
 *   FIREWATCH_DIST       built site to serve (default ../dist)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createReadStream } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PROJECTION, REGIONS, type Region } from "../src/config/regions";
import { fetchFwiStations, fetchHotspots, fetchPerimeters, type Perimeter } from "../src/data/cwfis";
import { fetchFireHistory } from "../src/data/fireHistory";
import { makeFwiSeed } from "../src/data/fwiSeed";
import { fetchWeatherGrid } from "../src/data/openMeteo";
import { setProjection } from "../src/geo/projection";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DIST = resolve(process.env.FIREWATCH_DIST ?? join(HERE, "..", "dist"));
const CACHE_DIR = join(HERE, ".cache");
const PREWARM = (process.env.FIREWATCH_PREWARM ?? "alberta").split(",").map((s) => s.trim()).filter(Boolean);

const REGION_LIST = Object.values(REGIONS);

const MIN = 60_000;
/** How long each kind of data stays fresh before it's refetched. */
/** Wait this long before retrying a source that failed. */
const RETRY_MS = 5 * MIN;
const TTL = { fires: 10 * MIN, stations: 60 * MIN, weather: 60 * MIN, history: 60 * MIN };

setProjection(PROJECTION);
mkdirSync(CACHE_DIR, { recursive: true });

/** One bbox covering every region: the server fetches fire data Canada-wide once. */
const CANADA: [number, number, number, number] = [
  Math.min(...REGION_LIST.map((r) => r.bbox[0])), Math.min(...REGION_LIST.map((r) => r.bbox[1])),
  Math.max(...REGION_LIST.map((r) => r.bbox[2])), Math.max(...REGION_LIST.map((r) => r.bbox[3])),
];

// ---------------------------------------------------------------- cache
/**
 * A value fetched at most once per `ttl`, shared by every request. Concurrent requests share one
 * fetch; a failed fetch serves the last good copy (memory, then disk) instead of an error.
 */
class Cached<T> {
  private value: T | undefined;
  private at = 0;
  private inflight: Promise<T> | null = null;
  /** After a failed fetch, don't ask the source again until this time (rate limits, outages). */
  private retryAt = 0;
  lastError = "";
  constructor(private key: string, private ttl: number, private load: () => Promise<T>) {
    const file = this.file();
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { at: number; value: T };
        this.value = saved.value;
        this.at = saved.at;
      } catch { /* corrupt cache: refetch */ }
    }
  }
  private file() { return join(CACHE_DIR, `${this.key.replace(/[^a-z0-9._-]/gi, "_")}.json`); }
  get fetchedAt() { return this.at; }
  get fresh() { return this.value !== undefined && Date.now() - this.at < this.ttl; }

  async get(): Promise<T> {
    if (this.fresh) return this.value as T;
    if (this.inflight) return this.inflight;
    if (Date.now() < this.retryAt) {
      if (this.value !== undefined) return this.value;
      throw new Error(this.lastError);
    }
    this.inflight = (async () => {
      try {
        const v = await this.load();
        this.value = v;
        this.at = Date.now();
        this.lastError = "";
        try { writeFileSync(this.file(), JSON.stringify({ at: this.at, value: v })); } catch { /* disk full: memory still works */ }
        return v;
      } catch (e) {
        this.lastError = (e as Error).message ?? String(e);
        this.retryAt = Date.now() + RETRY_MS;
        console.warn(`[data] ${this.key}: ${this.lastError}${this.value !== undefined ? " (serving the last good copy)" : ""}`);
        if (this.value !== undefined) return this.value;
        throw e;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

const hotspots = new Cached("hotspots", TTL.fires, () => fetchHotspots(CANADA));
const perimeters = new Cached("perimeters", TTL.fires, () => fetchPerimeters(CANADA));
const stations = new Cached("stations", TTL.stations, () => fetchFwiStations());

const weather = new Map<string, Cached<unknown>>();
function weatherFor(region: Region) {
  let c = weather.get(region.id);
  if (!c) {
    c = new Cached(`weather-${region.id}`, TTL.weather, async () => {
      // Seed the FWI System from the same official codes the browser would use.
      const [st, hs] = await Promise.all([stations.get().catch(() => []), hotspots.get().catch(() => [])]);
      return fetchWeatherGrid(region.bbox, undefined, makeFwiSeed(st, hs));
    });
    weather.set(region.id, c);
  }
  return c;
}

const histories = new Map<string, Cached<unknown>>();
function historyFor(p: Perimeter) {
  const key = `history-${p.id}-${p.lastDate}`;
  let c = histories.get(key);
  if (!c) histories.set(key, (c = new Cached(key, TTL.history, () => fetchFireHistory(p))));
  return c;
}

// ---------------------------------------------------------------- http
function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const json = Buffer.from(JSON.stringify(body));
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && json.length > 1024;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    ...extra,
  });
  res.end(gzip ? gzipSync(json) : json);
}

async function serve(req: IncomingMessage, res: ServerResponse, c: Cached<unknown>) {
  try {
    const v = await c.get();
    send(req, res, 200, v, { "X-Fetched-At": new Date(c.fetchedAt).toISOString() });
  } catch (e) {
    send(req, res, 502, { error: (e as Error).message ?? "Upstream error" });
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".bin": "application/octet-stream", ".pbf": "application/octet-stream",
};

/** Serve the built site from DIST (if it was built). */
function serveStatic(path: string, res: ServerResponse) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No built site in dist/ (run `npm run build`), or open the dev server instead.");
    return;
  }
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
  let file = join(DIST, rel || "index.html");
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) file = join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "*" });
    return res.end();
  }
  if (!p.startsWith("/api/")) return serveStatic(p, res);

  if (p === "/api/health") {
    const status = (c: Cached<unknown>) => ({ fresh: c.fresh, fetchedAt: c.fetchedAt ? new Date(c.fetchedAt).toISOString() : null, error: c.lastError || null });
    return send(req, res, 200, {
      ok: true,
      hotspots: status(hotspots as Cached<unknown>), perimeters: status(perimeters as Cached<unknown>), stations: status(stations as Cached<unknown>),
      weather: Object.fromEntries([...weather].map(([id, c]) => [id, status(c)])),
    });
  }
  if (p === "/api/cwfis/hotspots") return serve(req, res, hotspots as Cached<unknown>);
  if (p === "/api/cwfis/perimeters") return serve(req, res, perimeters as Cached<unknown>);
  if (p === "/api/cwfis/stations") return serve(req, res, stations as Cached<unknown>);

  const wx = p.match(/^\/api\/weather\/([a-z-]+)$/);
  if (wx) {
    const region = REGION_LIST.find((r) => r.id === wx[1]);
    return region ? serve(req, res, weatherFor(region)) : send(req, res, 404, { error: `Unknown region ${wx[1]}` });
  }
  const fh = p.match(/^\/api\/fire-history\/(.+)$/);
  if (fh) {
    const id = decodeURIComponent(fh[1]);
    try {
      const per = (await perimeters.get()).find((x) => x.id === id);
      return per ? serve(req, res, historyFor(per)) : send(req, res, 404, { error: `Unknown fire ${id}` });
    } catch (e) {
      return send(req, res, 502, { error: (e as Error).message });
    }
  }
  send(req, res, 404, { error: "Not found" });
});

// Keep the most-used data warm in the background so visitors never wait on a source.
async function warm() {
  await Promise.allSettled([hotspots.get(), perimeters.get(), stations.get()]);
  for (const id of PREWARM) {
    const r = REGION_LIST.find((x) => x.id === id);
    if (r) await weatherFor(r).get().catch(() => {});
  }
}
setInterval(() => { void warm(); }, 5 * MIN);

server.listen(PORT, () => {
  console.log(`FIRE//WATCH data server on http://localhost:${PORT}`);
  console.log(`  API:  /api/health, /api/cwfis/{hotspots,perimeters,stations}, /api/weather/<region>, /api/fire-history/<id>`);
  console.log(`  Site: ${existsSync(DIST) ? DIST : "(not built — run npm run build to serve it here)"}`);
  console.log(`  Kept warm: fire data + weather for ${PREWARM.join(", ") || "(none)"}`);
  void warm();
});
