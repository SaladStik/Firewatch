/**
 * Where the website gets its live data.
 *
 * By default the browser fetches every source directly (Open-Meteo, CWFIS).
 *
 * Start the app with VITE_DATA_SERVER set to a FIRE//WATCH data server's address
 * (e.g. `VITE_DATA_SERVER=http://localhost:8787`, see server/index.ts) and everything is read
 * from that server instead: it fetches each source once, caches it and shares it with every
 * visitor — no per-browser rate limits, and everyone sees the same data.
 */
import type { Region } from "../config/regions";
import { fetchFwiStations, fetchHotspots, fetchPerimeters, type FwiStation, type Hotspot, type Perimeter } from "./cwfis";
import { fetchFireHistory, type FireHistory } from "./fireHistory";
import { fetchWeatherGrid, type FwiSeed, type WeatherGrid } from "./openMeteo";

/** The data server's API base: `<VITE_DATA_SERVER>/api`, or "" to fetch sources directly. */
const SERVER = ((import.meta.env.VITE_DATA_SERVER as string | undefined) ?? "").trim().replace(/\/+$/, "");
const API = SERVER ? `${SERVER}/api` : "";

/** True when live data comes from the data server. */
export const usingDataServer = API.length > 0;

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
/** Fire weather stations' observed FWI codes. */
export const loadStations = (): Promise<FwiStation[]> => (usingDataServer ? api("/cwfis/stations") : fetchFwiStations());
/** One region's weather grid with the FWI System (the server seeds it itself). */
export const loadWeather = (region: Region, seed?: FwiSeed): Promise<WeatherGrid> =>
  usingDataServer ? api(`/weather/${encodeURIComponent(region.id)}`) : fetchWeatherGrid(region.bbox, undefined, seed);
/** A fire's daily growth from the hotspot archive. */
export const loadFireHistory = (p: Perimeter): Promise<FireHistory | null> =>
  usingDataServer ? api(`/fire-history/${encodeURIComponent(p.id)}`) : fetchFireHistory(p);
