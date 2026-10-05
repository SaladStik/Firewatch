/**
 * Where the website gets its live data.
 *
 * By default the browser fetches every source directly (Open-Meteo, CWFIS).
 *
 * Start the app with VITE_DATA_SERVER set to a FIRE//WATCH data server's address
 * (e.g. `VITE_DATA_SERVER=http://localhost:8787`, see server/index.ts) and everything is read
 * from that server instead: it fetches each source once, caches it and shares it with every
 * device — no per-browser rate limits, and everyone sees the same data.
 *
 * Every device must reach the server, so the address isn't baked into dev builds:
 *  - `npm run dev`: the page calls its own /api and Vite forwards it to VITE_DATA_SERVER
 *    (vite.config.ts), so phones and other computers only need to reach the dev server.
 *  - `npm run build`: the page calls `<VITE_DATA_SERVER>/api`. Use the server's public address,
 *    or `same-origin` when the data server hosts the built site itself (one address for everything).
 */
import type { Region } from "../config/regions";
import { fetchFwiStations, fetchHotspots, fetchPerimeters, type FwiStation, type Hotspot, type Perimeter } from "./cwfis";
import { fetchFireHistory, type FireHistory } from "./fireHistory";
import { fetchOpen311 } from "./calgary311";
import { fetchReportedFires, type ReportedFire } from "./reportedFires";
import type { LiveAircraft } from "./aircraft";
import type { Row311 } from "../dispatch/ops311";
import { fetchWeatherGrid, type FwiSeed, type WeatherGrid } from "./openMeteo";

/** The data server's address, or "" to fetch sources directly. */
const SERVER = ((import.meta.env?.VITE_DATA_SERVER as string | undefined) ?? "").trim();
/** The API base the page calls: `<address>/api` for a built site pointed at an http(s) address, otherwise
 * the page's own /api (proxied by Vite in dev; served by the data server for `same-origin`). */
const API = !SERVER ? "" : !import.meta.env?.DEV && /^https?:\/\//.test(SERVER) ? `${SERVER.replace(/\/+$/, "")}/api` : "/api";

/** True when live data comes from the data server. */
export const usingDataServer = API.length > 0;
/** A data server URL for `path` (e.g. "/ai/chat"). */
export const apiUrl = (path: string) => `${API}${path}`;

type BBox = [number, number, number, number];

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error ?? ""; } catch { /* not JSON */ }
    throw new Error(msg || `Data server ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Satellite hotspots, last 24 h (the server returns Canada-wide; callers tag regions). */
export const loadHotspots = (bbox: BBox): Promise<Hotspot[]> => (usingDataServer ? api("/cwfis/hotspots") : fetchHotspots(bbox));
/** Current-season fire perimeters. */
export const loadPerimeters = (bbox: BBox): Promise<Perimeter[]> => (usingDataServer ? api("/cwfis/perimeters") : fetchPerimeters(bbox));
/**
 * Agency-reported fires this season. The server keeps every agency's; the page keeps the ones it
 * asked for (plus Parks Canada, as fetchReportedFires does).
 */
export async function loadReportedFires(agencies: string[]): Promise<ReportedFire[]> {
  if (!usingDataServer) return fetchReportedFires(agencies);
  const keep = new Set([...agencies.map((a) => a.toUpperCase()), "PC"]);
  return (await api<ReportedFire[]>("/cwfif/reported")).filter((f) => keep.has(f.agency));
}
/** Fire weather stations' observed FWI codes. */
export const loadStations = (): Promise<FwiStation[]> => (usingDataServer ? api("/cwfis/stations") : fetchFwiStations());
/**
 * Firefighting aircraft in the air now (adsb.lol). Only through the data server: adsb.lol doesn't
 * allow calls from web pages. Null without a server.
 */
/**
 * Firefighting aircraft now. Always asked for from `/api/aircraft`, even with no data server:
 * no ADS-B service allows calls from a web page, so this one source always comes from
 * something server-side, and on a serverless deployment that is the Pages Function in
 * functions/api/aircraft.ts. Null when nothing answers, which hides the layer.
 */
export async function loadAircraft(): Promise<{ aircraft: LiveAircraft[]; fetchedAt: string; seenAircraft: number } | null> {
  try {
    const res = await fetch(usingDataServer ? `${API}/aircraft` : "/api/aircraft");
    return res.ok ? ((await res.json()) as { aircraft: LiveAircraft[]; fetchedAt: string; seenAircraft: number }) : null;
  } catch {
    return null;
  }
}
/** Calgary's live 311 queue (open crew field work; Open Calgary). */
export const loadCalgary311 = (): Promise<{ rows: Row311[]; fetchedAt: string }> => (usingDataServer ? api("/calgary311/open") : fetchOpen311());
/** One region's weather grid with the FWI System (the server seeds it itself). */
/**
 * One region's weather grid with the FWI System (the server seeds it itself).
 *
 * Without a data server the browser asks Open-Meteo directly, which is fine for a province or
 * two but not for all thirteen: every coordinate in a request is billed, so the whole country
 * is thousands of calls in seconds and the free tier starts refusing. So a refusal falls back
 * to the baked snapshot (scripts/bake-weather.ts) rather than leaving a province with no
 * weather at all. Live is always tried first, so a stale snapshot never overrides a working
 * source.
 */
export async function loadWeather(region: Region, seed?: FwiSeed): Promise<WeatherGrid> {
  if (usingDataServer) return api(`/weather/${encodeURIComponent(region.id)}`);
  try {
    return await fetchWeatherGrid(region.bbox, undefined, seed);
  } catch (live) {
    const res = await fetch(`${import.meta.env.BASE_URL}data/weather/${region.id}.json`).catch(() => null);
    if (!res?.ok) throw live; // no snapshot either: report the real problem, not a 404
    return (await res.json()) as WeatherGrid;
  }
}
/** A fire's daily growth from the hotspot archive. */
export const loadFireHistory = (p: Perimeter): Promise<FireHistory | null> =>
  usingDataServer ? api(`/fire-history/${encodeURIComponent(p.id)}`) : fetchFireHistory(p);
