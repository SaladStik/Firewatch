/**
 * FIRE//WATCH data server.
 *
 *   npm run server                       (http://<this machine>:8787)
 *
 * Fetches the live sources the website would otherwise fetch from every visitor's browser —
 * Open-Meteo weather (+ the FWI System), CWFIS hotspots / perimeters / fire weather stations and
 * each fire's growth history — once per refresh window, caches them in memory and on disk
 * (server/.cache, survives restarts) and serves the same copy to every device.
 *
 * Built for many devices at once:
 *  - Each value is serialised and gzipped once when it's fetched, not per request, and carries an
 *    ETag, so a device that already has the latest copy gets a bodyless 304.
 *  - Stale data is served instantly while one background refresh runs (stale-while-revalidate);
 *    concurrent requests for the same thing share a single upstream fetch.
 *  - Upstream calls are queued (one Open-Meteo request at a time, two archive queries) so a crowd
 *    of devices can never burst the sources' rate limits; a failing source is retried after a
 *    back-off while the last good copy keeps being served.
 *  - Only known region and fire ids are fetched, and old fire histories are dropped, so the cache
 *    can't grow without bound.
 *
 * The website uses it when started with VITE_DATA_SERVER set (see src/data/liveData.ts and
 * RUNBOOK.md); otherwise it fetches the sources itself, as before. If a built site exists in
 * dist/, it's served too, so devices only need this one address.
 *
 * Environment:
 *   PORT                 port to listen on (default 8787, all network interfaces)
 *   FIREWATCH_PREWARM    regions whose weather is kept fresh in the background, comma-separated
 *                        region ids (default "alberta"; others are fetched when first requested)
 *   FIREWATCH_DIST       built site to serve (default ../dist)
 *   FIREWATCH_CACHE_DIR  where the disk cache lives (default server/.cache). Point this at a
 *                        writable path when the app directory isn't one, e.g. on Databricks
 *                        Apps or any read-only container (see DEPLOY-DATABRICKS.md)
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { PROJECTION, REGIONS, type Region } from "../src/config/regions";
import { fetchFwiStations, fetchHotspots, fetchPerimeters, type Perimeter } from "../src/data/cwfis";
import { fetchFireHistory } from "../src/data/fireHistory";
import { fetchOpen311 } from "../src/data/calgary311";
import type { Site } from "../src/dispatch/cityContext";
import { Worker } from "node:worker_threads";
import { makeFwiSeed } from "../src/data/fwiSeed";
import { fetchWeatherGrid } from "../src/data/openMeteo";
import { setProjection } from "../src/geo/projection";

const gzipAsync = promisify(gzip);

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DIST = resolve(process.env.FIREWATCH_DIST ?? join(HERE, "..", "dist"));
/** Disk cache. Overridable because a container's app directory isn't a safe place to write. */
const CACHE_DIR = resolve(process.env.FIREWATCH_CACHE_DIR ?? join(HERE, ".cache"));
const PREWARM = (process.env.FIREWATCH_PREWARM ?? "alberta").split(",").map((s) => s.trim()).filter(Boolean);

const REGION_LIST = Object.values(REGIONS);

const MIN = 60_000;
/** Wait this long before retrying a source that failed. */
const RETRY_MS = 5 * MIN;
/** How long each kind of data stays fresh before it's refetched. */
const TTL = { fires: 10 * MIN, stations: 60 * MIN, weather: 60 * MIN, history: 60 * MIN };
/** Fire histories kept in memory (one per active fire; least recently used are dropped first). */
const MAX_HISTORIES = 1000;

setProjection(PROJECTION);
mkdirSync(CACHE_DIR, { recursive: true });

/** One bbox covering every region: the server fetches fire data Canada-wide once. */
const CANADA: [number, number, number, number] = [
  Math.min(...REGION_LIST.map((r) => r.bbox[0])), Math.min(...REGION_LIST.map((r) => r.bbox[1])),
  Math.max(...REGION_LIST.map((r) => r.bbox[2])), Math.max(...REGION_LIST.map((r) => r.bbox[3])),
];

// ---------------------------------------------------------------- upstream queue
/** Runs at most `n` upstream fetches at once; the rest wait their turn. */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((go) => this.queue.push(go));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
/** Open-Meteo has per-minute and per-hour caps: one weather grid at a time. */
const openMeteo = new Limiter(1);
/** The CWFIS hotspot archive queries are heavy: two at a time. */
const archive = new Limiter(2);

// ---------------------------------------------------------------- cache
/** A value ready to send: serialised and gzipped once, shared by every request. */
interface Encoded { json: Buffer; gz: Buffer; etag: string; at: number }

async function encode(value: unknown, at: number): Promise<Encoded> {
  const json = Buffer.from(JSON.stringify(value));
  const gz = await gzipAsync(json); // off the main thread (libuv pool)
  return { json, gz, etag: `"${createHash("sha1").update(json).digest("base64url")}"`, at };
}

/**
 * A value fetched at most once per `ttl`, shared by every request.
 *  - Fresh: served from memory.
 *  - Stale: served immediately while one background refresh runs.
 *  - Missing: the first request fetches it; concurrent requests wait on that same fetch.
 * A failed fetch keeps the last good copy (memory, then disk) and backs off before retrying.
 */
class Cached<T> {
  private value: T | undefined;
  private encoded: Promise<Encoded> | null = null;
  private at = 0;
  private inflight: Promise<T> | null = null;
  private retryAt = 0;
  lastError = "";
  constructor(private key: string, private ttl: number, private load: () => Promise<T>) {
    const file = this.file();
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as { at: number; value: T };
        this.set(saved.value, saved.at);
      } catch { /* corrupt cache: refetch */ }
    }
  }
  private file() { return join(CACHE_DIR, `${this.key.replace(/[^a-z0-9._-]/gi, "_")}.json`); }
  private set(v: T, at: number) {
    this.value = v;
    this.at = at;
    this.encoded = encode(v, at);
  }
  get fetchedAt() { return this.at; }
  get fresh() { return this.value !== undefined && Date.now() - this.at < this.ttl; }

  private refresh(): Promise<T> {
    if (this.inflight) return this.inflight;
    if (Date.now() < this.retryAt) {
      return this.value !== undefined ? Promise.resolve(this.value) : Promise.reject(new Error(this.lastError));
    }
    this.inflight = (async () => {
      try {
        const v = await this.load();
        this.set(v, Date.now());
        this.lastError = "";
        this.retryAt = 0;
        writeFile(this.file(), JSON.stringify({ at: this.at, value: v })).catch(() => { /* disk full: memory still works */ });
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

  /** The value (for the server's own use, e.g. looking up a fire). */
  async get(): Promise<T> {
    if (this.value === undefined) return this.refresh();
    if (!this.fresh) void this.refresh().catch(() => {}); // stale: refresh in the background
    return this.value;
  }

  /** The value ready to send. */
  async body(): Promise<Encoded> {
    await this.get();
    return this.encoded as Promise<Encoded>;
  }
}

const hotspots = new Cached("hotspots", TTL.fires, () => fetchHotspots(CANADA));
/** Outline points to 5 decimals (~1 m, far below a hex): a third less to send to every device. */
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
const perimeters = new Cached("perimeters", TTL.fires, async () =>
  (await fetchPerimeters(CANADA)).map((p) => ({ ...p, rings: p.rings.map((ring) => ring.map(([x, y]) => [round5(x), round5(y)] as [number, number])) })));
const stations = new Cached("stations", TTL.stations, () => fetchFwiStations());
/**
 * Calgary's live 311 queue (crew field work), refreshed every 10 minutes like the fire data, with
 * each open ticket's site (the road it's on, schools, crossings, slope, 311 history around it)
 * worked out once, in a worker thread (server/calgary311.worker.ts) so this event loop keeps
 * serving while ~25,000 tickets are scored. No browser has to score them itself.
 */
let siteWorker: Worker | null = null;
let siteReq = 0;
function scoreSites(rows: unknown[], fetchedAt: string): Promise<Record<string, Site>> {
  siteWorker ??= new Worker(new URL("./calgary311.worker.ts", import.meta.url), { execArgv: process.execArgv });
  const w = siteWorker, id = ++siteReq;
  return new Promise((resolve, reject) => {
    const done = (m: { id: number; sites?: Record<string, Site>; error?: string }) => {
      if (m.id !== id) return;
      w.off("message", done); w.off("error", fail);
      if (m.sites) resolve(m.sites); else reject(new Error(m.error ?? "site scoring failed"));
    };
    const fail = (e: Error) => { w.off("message", done); siteWorker = null; reject(e); };
    w.on("message", done);
    w.once("error", fail);
    w.postMessage({ id, rows, fetchedAt });
  });
}
const calgary311 = new Cached("calgary311", TTL.fires, async () => {
  const r = await fetchOpen311();
  let sites: Record<string, Site> | undefined;
  try {
    sites = await scoreSites(r.rows, r.fetchedAt);
  } catch (e) {
    console.warn("[data] calgary311 sites:", (e as Error).message); // browsers work them out instead
  }
  return { ...r, sites };
});

const weather = new Map<string, Cached<unknown>>();
function weatherFor(region: Region) {
  let c = weather.get(region.id);
  if (!c) {
    c = new Cached(`weather-${region.id}`, TTL.weather, async () => {
      // Seed the FWI System from the same official codes the browser would use.
      const [st, hs] = await Promise.all([stations.get().catch(() => []), hotspots.get().catch(() => [])]);
      return openMeteo.run(() => fetchWeatherGrid(region.bbox, undefined, makeFwiSeed(st, hs)));
    });
    weather.set(region.id, c);
  }
  return c;
}

/** Keyed by fire id + last perimeter update, so a fire that grew gets a fresh history. */
const histories = new Map<string, Cached<unknown>>();
function historyFor(p: Perimeter) {
  const key = `history-${p.id}-${p.lastDate}`;
  let c = histories.get(key);
  if (c) {
    histories.delete(key); // re-insert: Map order doubles as least-recently-used order
    histories.set(key, c);
    return c;
  }
  for (const k of histories.keys()) if (k.startsWith(`history-${p.id}-`)) histories.delete(k); // superseded
  while (histories.size >= MAX_HISTORIES) histories.delete(histories.keys().next().value as string);
  c = new Cached(key, TTL.history, () => archive.run(() => fetchFireHistory(p)));
  histories.set(key, c);
  return c;
}

// ---------------------------------------------------------------- http
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "ETag, X-Fetched-At" };

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
}

/** Send a cached value: gzipped if the device accepts it, 304 if it already has this copy. */
async function serve(req: IncomingMessage, res: ServerResponse, c: Cached<unknown>) {
  let e: Encoded;
  try {
    e = await c.body();
  } catch (err) {
    return sendJson(req, res, 502, { error: (err as Error).message || "Upstream error" });
  }
  const headers = {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    // Devices always revalidate; with the ETag that's a tiny 304 when nothing changed.
    "Cache-Control": "no-cache",
    ETag: e.etag,
    Vary: "Accept-Encoding",
    "X-Fetched-At": new Date(e.at).toISOString(),
  };
  if (req.headers["if-none-match"] === e.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const buf = gz ? e.gz : e.json;
  res.writeHead(200, { ...headers, ...(gz ? { "Content-Encoding": "gzip" } : {}), "Content-Length": buf.length });
  res.end(req.method === "HEAD" ? undefined : buf);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
  ".woff": "font/woff", ".bin": "application/octet-stream", ".pbf": "application/octet-stream", ".geojson": "application/geo+json",
};

/** Serve the built site from DIST (if it was built). */
function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No built site in dist/ (run `npm run build`), or open the dev server instead.");
    return;
  }
  let rel: string;
  try { rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, ""); } catch { res.writeHead(400); res.end(); return; }
  let file = join(DIST, rel || "index.html");
  if (file !== DIST && !file.startsWith(DIST + sep)) { res.writeHead(403); res.end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) file = join(DIST, "index.html");
  const st = statSync(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": st.size,
    ETag: etag,
    // Vite's hashed bundles never change; everything else is revalidated.
    "Cache-Control": rel.replace(/\\/g, "/").startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" });
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(req, res, 405, { error: "Method not allowed" });
  if (!p.startsWith("/api/")) return serveStatic(req, res, p);

  if (p === "/api/health") {
    const status = (c: Cached<unknown>) => ({ fresh: c.fresh, fetchedAt: c.fetchedAt ? new Date(c.fetchedAt).toISOString() : null, error: c.lastError || null });
    return sendJson(req, res, 200, {
      ok: true,
      hotspots: status(hotspots as Cached<unknown>), perimeters: status(perimeters as Cached<unknown>), stations: status(stations as Cached<unknown>), calgary311: status(calgary311 as Cached<unknown>),
      weather: Object.fromEntries([...weather].map(([id, c]) => [id, status(c)])),
      fireHistories: histories.size,
    });
  }
  if (p === "/api/cwfis/hotspots") return serve(req, res, hotspots as Cached<unknown>);
  if (p === "/api/cwfis/perimeters") return serve(req, res, perimeters as Cached<unknown>);
  if (p === "/api/cwfis/stations") return serve(req, res, stations as Cached<unknown>);
  if (p === "/api/calgary311/open") return serve(req, res, calgary311 as Cached<unknown>);

  const wx = p.match(/^\/api\/weather\/([a-z-]+)$/);
  if (wx) {
    const region = REGION_LIST.find((r) => r.id === wx[1]);
    return region ? serve(req, res, weatherFor(region)) : sendJson(req, res, 404, { error: `Unknown region ${wx[1]}` });
  }
  const fh = p.match(/^\/api\/fire-history\/(.+)$/);
  if (fh) {
    let id: string;
    try { id = decodeURIComponent(fh[1]); } catch { return sendJson(req, res, 400, { error: "Bad fire id" }); }
    try {
      const per = (await perimeters.get()).find((x) => x.id === id);
      return per ? serve(req, res, historyFor(per)) : sendJson(req, res, 404, { error: `Unknown fire ${id}` });
    } catch (e) {
      return sendJson(req, res, 502, { error: (e as Error).message });
    }
  }
  sendJson(req, res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[http]", e);
    if (!res.headersSent) sendJson(req, res, 500, { error: "Server error" });
    else res.destroy();
  });
});
// Keep idle connections open a little longer than typical proxies/browsers expect.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

// Keep the most-used data warm in the background so devices never wait on a source.
async function warm() {
  await Promise.allSettled([hotspots.get(), perimeters.get(), stations.get(), calgary311.get()]);
  for (const id of PREWARM) {
    const r = REGION_LIST.find((x) => x.id === id);
    if (r) await weatherFor(r).get().catch(() => {});
  }
}
setInterval(() => { void warm(); }, 5 * MIN);

/** This machine's addresses on the local network, for other devices to connect to. */
function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
}

server.listen(PORT, () => {
  console.log(`FIRE//WATCH data server`);
  console.log(`  This machine:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Other devices:  http://${ip}:${PORT}`);
  console.log(`  API:  /api/health, /api/cwfis/{hotspots,perimeters,stations}, /api/weather/<region>, /api/fire-history/<id>`);
  console.log(`  Site: ${existsSync(DIST) ? DIST : "(not built — run npm run build to serve it here)"}`);
  console.log(`  Kept warm: fire data + weather for ${PREWARM.join(", ") || "(none)"}`);
  void warm();
});
