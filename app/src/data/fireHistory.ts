/**
 * How fast each active fire has ACTUALLY been growing, from its own satellite history,
 * used to calibrate the spread model per fire ("will this one go one node or five?").
 *
 * Source: the CWFIS hotspot archive (public:hotspots, every detection since 2012) for the
 * fire's perimeter since its first date. Each day's NEW ~400 m hotspot cells are that day's
 * newly burned ground; scaling the cumulative cells to the perimeter's mapped area gives the
 * burned area per day, and its equivalent radius gives radial growth in km/day.
 *
 * Calibration: over the last few days, observed radial growth ÷ what our spread model
 * predicts for those same days (from the weather that actually happened there) = the fire's
 * factor `k`. Projections multiply head spread by `k` (weighted by how much history there is).
 */
import { project } from "../geo/projection";
import type { Perimeter } from "./cwfis";
import { headBackRatio, headKmPerDay, lengthToBreadth } from "./fireSpread";
import type { DayWeather } from "./openMeteo";

const WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows";
/** Hotspot cell size (km): about one VIIRS pixel. */
const CELL_KM = 0.4;
/** Days of recent behaviour the calibration looks at. */
export const CALIBRATION_DAYS = 5;
/** Days with growth needed for full confidence in the calibration. */
const FULL_CONFIDENCE_DAYS = 4;
/** Calibration factor limits. */
const K_MIN = 0.2; // a holding fire can still flare up: never project less than a fifth of the model
const K_MAX = 4;

export interface FireDay {
  date: string; // YYYY-MM-DD (UTC)
  areaHa: number; // cumulative burned area by the end of the day
  growthKm: number; // equivalent-radius growth that day
}

export interface FireHistory {
  id: string;
  /** Perimeter lastDate when fetched (refetch when it changes). */
  lastDate: string;
  days: FireDay[];
}

export interface FireGrowth {
  /** Multiplier on modelled spread for this fire (1 = model as is). */
  k: number;
  /** 0..1: how much history backs `k`. */
  confidence: number;
  /** Recent observed / modelled radial growth (km/day) over the calibration window. */
  observedKmDay: number;
  modelKmDay: number;
}

/** Fetch a fire's archived hotspots and rebuild its daily growth. Null when there's nothing usable. */
export async function fetchFireHistory(p: Perimeter, signal?: AbortSignal): Promise<FireHistory | null> {
  const ring = p.rings[0];
  if (!ring?.length) return null;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const r of p.rings) for (const [lng, lat] of r) { x0 = Math.min(x0, lng); x1 = Math.max(x1, lng); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat); }
  const pad = 0.01;
  const cql = `lon BETWEEN ${(x0 - pad).toFixed(4)} AND ${(x1 + pad).toFixed(4)} AND lat BETWEEN ${(y0 - pad).toFixed(4)} AND ${(y1 + pad).toFixed(4)} AND rep_date >= '${p.firstDate.slice(0, 10)}T00:00:00Z'`;
  const q = new URLSearchParams({
    service: "WFS", version: "1.0.0", request: "GetFeature", outputFormat: "application/json",
    typeName: "public:hotspots", propertyName: "rep_date,lat,lon", CQL_FILTER: cql,
  });
  const res = await fetch(`${WFS}?${q}`, { signal });
  if (!res.ok) throw new Error(`CWFIS history ${res.status}`);
  const json = await res.json();
  const pts = ((json.features ?? []) as { properties: { rep_date: string; lat: number; lon: number } }[])
    .map((f) => f.properties)
    .filter((h) => p.rings.some((r) => insideRing(r, h.lon, h.lat)));
  return { id: p.id, lastDate: p.lastDate, days: dailyGrowth(pts, p.areaHa) };
}

/**
 * Daily cumulative area + radial growth from dated hotspots, scaled so the total matches the
 * perimeter's mapped area. Days without detections are filled in (zero growth).
 */
export function dailyGrowth(pts: { rep_date: string; lat: number; lon: number }[], areaHa: number): FireDay[] {
  if (!pts.length) return [];
  const sorted = [...pts].sort((a, b) => a.rep_date.localeCompare(b.rep_date));
  const seen = new Set<string>();
  const newByDay = new Map<string, number>();
  for (const h of sorted) {
    const { x, z } = project(h.lat, h.lon);
    const key = `${Math.floor(x / CELL_KM)},${Math.floor(z / CELL_KM)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = h.rep_date.slice(0, 10);
    newByDay.set(d, (newByDay.get(d) ?? 0) + 1);
  }
  const haPerCell = areaHa / seen.size;
  const out: FireDay[] = [];
  let cells = 0, prevR = 0;
  const first = new Date(`${sorted[0].rep_date.slice(0, 10)}T00:00:00Z`), last = new Date(`${sorted[sorted.length - 1].rep_date.slice(0, 10)}T00:00:00Z`);
  for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    cells += newByDay.get(date) ?? 0;
    const areaHa = cells * haPerCell;
    const r = Math.sqrt(areaHa / 100 / Math.PI); // km
    out.push({ date, areaHa, growthKm: r - prevR });
    prevR = r;
  }
  return out;
}

/** Modelled equivalent-radius growth (km) for one day of weather: same model as the projection. */
export function modelRadialKm(w: DayWeather): number {
  const h = headKmPerDay(w.risk);
  const lb = lengthToBreadth(Number.isFinite(w.wind) ? w.wind : 0);
  const b = h / headBackRatio(lb);
  // A day's ellipse from a point: semi-axes (h+b)/2 and (h+b)/(2·lb) → equivalent radius.
  return (h + b) / (2 * Math.sqrt(lb));
}

/**
 * Calibrate one fire: observed growth over the last CALIBRATION_DAYS (before today) vs the
 * model on those days' actual weather. `past`/`pastDates` are the fire's weather cell history.
 */
export function growthCalibration(hist: FireHistory, past: DayWeather[], pastDates: string[]): FireGrowth {
  const byDate = new Map(hist.days.map((d) => [d.date, d.growthKm]));
  const window = pastDates.map((date, i) => ({ date, w: past[i] })).slice(-CALIBRATION_DAYS);
  let obs = 0, model = 0;
  for (const { date, w } of window) {
    obs += Math.max(0, byDate.get(date) ?? 0);
    if (w) model += modelRadialKm(w);
  }
  const activeDays = hist.days.filter((d) => d.growthKm > 0.01).length;
  const confidence = window.length ? Math.min(1, activeDays / FULL_CONFIDENCE_DAYS) : 0;
  // Small floor on both so "no growth in calm weather" reads as ~1, not 0/0.
  const raw = Math.min(K_MAX, Math.max(K_MIN, (obs + 0.05) / (model + 0.05)));
  const k = Math.exp(confidence * Math.log(raw));
  const n = Math.max(1, window.length);
  return { k, confidence, observedKmDay: obs / n, modelKmDay: model / n };
}

/** How much a fire's calibration stretches its zone of influence on risk (gentler than spread itself). */
export const reachScale = (k: number) => Math.min(1.6, Math.max(0.6, Math.sqrt(k)));

/** Point-in-ring test in lng/lat. */
export function insideRing(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The active perimeter (with a calibration) a point falls in, if any. */
export function perimeterAt(perimeters: Perimeter[], lat: number, lng: number): Perimeter | undefined {
  return perimeters.find((p) => p.rings.some((r) => insideRing(r, lng, lat)));
}
