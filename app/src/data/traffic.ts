/**
 * Traffic volumes on the numbered highway network, and what they are expected to be on a
 * given day.
 *
 * Baked per region by `scripts/bake_traffic.py` from provincial open data (measured volumes
 * joined to highway geometry) and shipped as a static file, like places.json and terrain.png.
 * It travels with the site in both data modes: the optional data server (server/index.ts)
 * only fronts the *live* sources, so there is nothing region-specific to route through it.
 *
 * The baked file holds measured yearly figures. Two measured quantities turn them into a
 * figure for a particular day:
 *   - AADT → SADT, the province's own annual and summer averages, give the seasonal swing.
 *   - the published volume history gives each highway's annual growth, which carries the
 *     last measured year forward to the year being asked about.
 * Nothing here invents a shape the sources don't publish: Alberta reports no day-of-week or
 * hour-of-day breakdown, so the prediction is at daily resolution, which is the resolution
 * the forecast slider works at anyway.
 */
import { project } from "../geo/projection";

/** One numbered highway, with the volumes the province measured on it. */
export interface Highway {
  /** Highway number as signed, e.g. "63", "2A". */
  n: string;
  /** 0 = primary highway, 1 = secondary highway. */
  cls: number;
  /** Measured annual average daily traffic, length-weighted over the highway (vehicles/day). */
  aadt: number;
  /** Measured summer average daily traffic, length-weighted (vehicles/day). */
  sadt: number;
  /** Share of the volume that is commercial — buses, single-unit trucks, tractor-trailers (%). */
  commercial: number;
  /** Lowest and highest section volume measured on this highway (vehicles/day). */
  lo: number;
  hi: number;
  /** Length the province measured (km). */
  km: number;
  /** Annual growth from the published history (%/yr; negative where traffic is falling). */
  growth: number;
}

/**
 * One region's highway network as flat arrays — one entry per sample point along the routes,
 * which is what proximity scoring walks.
 */
export interface TrafficNetwork {
  /** Workspace index of the region these highways belong to. */
  region: number;
  source: string;
  attribution: string;
  /** Year the volumes were measured. */
  year: number;
  /** First year of the growth history. */
  historyFrom: number;
  /** How far the stored routes may stray from the real centreline (km). */
  toleranceKm: number;
  /** Longest gap between consecutive points of a route (km). */
  maxGapKm: number;
  highways: Highway[];
  /** Projected world position of each sample point (km). */
  x: Float32Array;
  z: Float32Array;
  lat: Float32Array;
  lng: Float32Array;
  /** Index into `highways` for each sample point. */
  hwy: Uint16Array;
  /** Local annual average daily traffic at each sample point (vehicles/day). */
  aadt: Float32Array;
  /**
   * Where each route starts in the arrays above, and how many points it has. Points within a
   * route are consecutive, but not evenly spaced: the bake spends them where the road curves
   * (see TrafficField, which measures each route to let anything drive along it).
   */
  routeStart: Int32Array;
  routeCount: Int32Array;
}

/**
 * Vehicles a day this highway can carry before it backs up.
 *
 * There are no published lane counts, but there is something better: the busiest day the
 * province has actually measured on the highway. A road that has carried 172,440 vehicles
 * demonstrably has the capacity for them — and comfortably, because it was built with
 * headroom over its ordinary day. So the measured peak is taken to be about half of what the
 * road can pass before it fails, which is what leaves an ordinary day free-flowing and makes
 * a doubling of demand — an evacuation — the thing that jams it.
 */
export const CAPACITY_HEADROOM = 2;

export function capacity(h: Pick<Highway, "aadt" | "hi">): number {
  return Math.max(h.hi, h.aadt) * CAPACITY_HEADROOM;
}

/**
 * How jammed a stretch is (0 = free-flowing, 1 = gridlock) at a volume, against that
 * highway's capacity. Squared, so congestion stays invisible until the road is genuinely
 * near its limit and then comes on fast — which is how traffic actually fails.
 */
export function jamLevel(volume: number, cap: number): number {
  if (!(cap > 0)) return 0;
  const load = volume / cap;
  return load <= 0.6 ? 0 : Math.min(1, ((load - 0.6) / 0.4) ** 2);
}

/** Shape of public/data/<region>/traffic.json. */
interface TrafficFile {
  source: string;
  attribution: string;
  year: number;
  historyFrom: number;
  toleranceKm: number;
  maxGapKm: number;
  /** Coordinate quantisation: stored units per degree. */
  q: number;
  highways: { n: string; c: number; aadt: number; sadt: number; cm: number; lo: number; hi: number; km: number; g: number }[];
  /** One route each: [highwayIndex, lat, lng, volume%, dlat, dlng, volume%, …]. */
  points: number[][];
}

/**
 * The province's summer average covers these days of the year, so that's the window the
 * seasonal curve below is fitted over (Alberta's WASDT is a June–August average).
 */
const SUMMER_FROM = 152; // 1 June
const SUMMER_TO = 243; // 31 August
/** Day of the year the curve peaks (mid-July, the middle of the summer window). */
const SEASON_PEAK = (SUMMER_FROM + SUMMER_TO) / 2;

const phase = (doy: number) => (2 * Math.PI * (doy - SEASON_PEAK)) / 365;

/**
 * Mean of the seasonal cosine over the summer window. The curve's amplitude is scaled by
 * this so that its average across the window reproduces the measured summer figure exactly.
 */
const SUMMER_MEAN_COS = (() => {
  let sum = 0;
  for (let d = SUMMER_FROM; d <= SUMMER_TO; d++) sum += Math.cos(phase(d));
  return sum / (SUMMER_TO - SUMMER_FROM + 1);
})();

/** Day of the year, 1 = 1 January. */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000) + 1;
}

/**
 * Seasonal multiplier on a highway's annual average for one day of the year.
 *
 * A cosine peaking in mid-July, with its amplitude set by the gap between the measured
 * annual and summer averages: averaged over the summer window it returns sadt/aadt, and
 * averaged over the whole year it returns 1.
 */
export function seasonalFactor(h: Pick<Highway, "aadt" | "sadt">, doy: number): number {
  if (!(h.aadt > 0)) return 1;
  const amplitude = (h.sadt / h.aadt - 1) / SUMMER_MEAN_COS;
  return Math.max(0.1, 1 + amplitude * Math.cos(phase(doy)));
}

/** Growth carried from the measured year to `year` (1 = no change). */
export function trendFactor(h: Pick<Highway, "growth">, measuredYear: number, year: number): number {
  const years = Math.max(0, Math.min(15, year - measuredYear)); // never extrapolate far
  return (1 + h.growth / 100) ** years;
}

/**
 * Vehicles per day expected at a sample point on a date: its local measured volume, moved
 * to that date's place in the season and forward from the year it was measured.
 */
export function predictVolume(net: TrafficNetwork, i: number, date: Date): number {
  const h = net.highways[net.hwy[i]];
  if (!h) return 0;
  return net.aadt[i] * seasonalFactor(h, dayOfYear(date)) * trendFactor(h, net.year, date.getFullYear());
}

/** Decode a traffic file into flat arrays, projected into world km. */
export function decodeTraffic(file: TrafficFile, region: number): TrafficNetwork {
  const total = file.points.reduce((n, row) => n + (row.length - 1) / 3, 0);
  const net: TrafficNetwork = {
    region,
    source: file.source,
    attribution: file.attribution,
    year: file.year,
    historyFrom: file.historyFrom,
    toleranceKm: file.toleranceKm,
    maxGapKm: file.maxGapKm,
    highways: file.highways.map((h) => ({
      n: h.n, cls: h.c, aadt: h.aadt, sadt: h.sadt, commercial: h.cm, lo: h.lo, hi: h.hi, km: h.km, growth: h.g,
    })),
    x: new Float32Array(total),
    z: new Float32Array(total),
    lat: new Float32Array(total),
    lng: new Float32Array(total),
    hwy: new Uint16Array(total),
    aadt: new Float32Array(total),
    routeStart: new Int32Array(file.points.length),
    routeCount: new Int32Array(file.points.length),
  };
  let n = 0;
  let r = 0;
  for (const row of file.points) {
    net.routeStart[r] = n;
    const hi = row[0];
    const base = net.highways[hi]?.aadt ?? 0;
    let qLat = 0, qLng = 0;
    for (let i = 1; i < row.length; i += 3) {
      // First point is absolute, the rest are deltas (see bake_traffic.py encode()).
      if (i === 1) { qLat = row[i]; qLng = row[i + 1]; } else { qLat += row[i]; qLng += row[i + 1]; }
      const lat = qLat / file.q, lng = qLng / file.q;
      const w = project(lat, lng);
      net.lat[n] = lat; net.lng[n] = lng;
      net.x[n] = w.x; net.z[n] = w.z;
      net.hwy[n] = hi;
      net.aadt[n] = (base * row[i + 2]) / 100;
      n++;
    }
    net.routeCount[r] = n - net.routeStart[r];
    r++;
  }
  return net;
}

/**
 * One region's baked traffic network, or null when that region has no traffic data
 * (only provinces with an adapter in bake_traffic.py ship a file).
 */
export async function loadTraffic(dataUrl: string, region: number): Promise<TrafficNetwork | null> {
  try {
    const r = await fetch(`${dataUrl}/traffic.json`);
    if (!r.ok) return null;
    return decodeTraffic((await r.json()) as TrafficFile, region);
  } catch {
    return null; // no traffic data for this region; the layer just stays empty
  }
}
