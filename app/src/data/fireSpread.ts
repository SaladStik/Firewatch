/**
 * Projected fire spread: a simplified SCENARIO model, not an operational forecast.
 * Each active fire (CWFIS perimeter or hotspot cluster) grows as an ellipse per day:
 *   head distance  h = HEAD_MAX_KM_DAY × risk^1.5       (risk = Fosberg/100 × dryness)
 *   length:breadth from wind (Anderson 1983), head:back from L:B (Alexander 1985)
 *   head points downwind; distances accumulate day by day.
 * The map shows the union of each day's ellipse up to the selected day.
 * Ignores slope, suppression, fuel breaks and spotting.
 */
import { project } from "../geo/projection";
import { downwind } from "../world/spread";
import type { Hotspot, Perimeter } from "./cwfis";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import { blobDamping, blobRain, type RainBlob } from "./rain";

/** Head spread (km/day) at the maximum weather risk. */
const HEAD_MAX_KM_DAY = 30;
/** Hotspots closer than this (km) are one fire. */
const CLUSTER_KM = 3;
/** Smallest radius given to a hotspot cluster (km; one satellite pixel ≈ 0.4 km). */
const MIN_R0_KM = 0.4;
/** Below this total growth (km) a day adds no ellipse. */
const MIN_GROWTH_KM = 0.05;
/** Midflame wind ≈ this fraction of the 10 m wind (forest canopy). */
const MIDFLAME = 0.4;
const MAX_LB = 8;

export interface FireSource {
  x: number;
  z: number;
  lat: number;
  lng: number;
  /** Current fire radius (km). */
  r0: number;
  kind: "perimeter" | "hotspots";
}

/** Plain data: crosses into the worker inside the HazardSnapshot. */
export interface SpreadEllipse {
  cx: number;
  cz: number;
  /** Unit major axis (downwind). */
  ux: number;
  uz: number;
  /** Semi-axes along / across the wind (km). */
  a: number;
  b: number;
  /** Forecast day this ellipse is for. */
  day: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Fire length:breadth ratio from the 10 m wind in km/h (Anderson 1983, midflame wind in mph). */
export function lengthToBreadth(windKmh: number): number {
  const u = (Math.max(0, windKmh) * MIDFLAME) / 1.609344;
  return Math.min(MAX_LB, Math.max(1, 0.936 * Math.exp(0.2566 * u) + 0.461 * Math.exp(-0.1548 * u) - 0.397));
}

/** Head:back spread ratio from length:breadth (Alexander 1985). */
export function headBackRatio(lb: number): number {
  const s = Math.sqrt(Math.max(0, lb * lb - 1));
  return (lb + s) / (lb - s);
}

/** Head-fire spread for one day (km) from weather risk 0..1. */
export function headKmPerDay(risk: number): number {
  return HEAD_MAX_KM_DAY * Math.pow(Math.max(0, risk), 1.5);
}

/** Active perimeters, plus hotspot clusters that aren't already inside one. */
export function fireSources(hotspots: Pick<Hotspot, "lat" | "lng">[], perimeters: Perimeter[], now = Date.now()): FireSource[] {
  const out: FireSource[] = [];
  for (const p of perimeters) {
    const ring = p.rings[0];
    if (!ring?.length || !isPerimeterActive(p, now)) continue;
    const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length, lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    out.push({ ...project(lat, lng), lat, lng, r0: Math.sqrt(p.areaHa / 100 / Math.PI), kind: "perimeter" });
  }
  const perims = [...out];
  const pts = hotspots
    .map((h) => ({ ...project(h.lat, h.lng), lat: h.lat, lng: h.lng }))
    .filter((h) => !perims.some((p) => Math.hypot(h.x - p.x, h.z - p.z) <= p.r0 + 1));
  // Single-linkage clustering (union-find): hotspots within CLUSTER_KM of each other are one fire.
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    if (Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) <= CLUSTER_KM) parent[find(i)] = find(j);
  }
  const groups = new Map<number, typeof pts>();
  pts.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  });
  for (const g of groups.values()) {
    const mean = (k: "x" | "z" | "lat" | "lng") => g.reduce((s, p) => s + p[k], 0) / g.length;
    const x = mean("x"), z = mean("z");
    const r0 = Math.max(MIN_R0_KM, ...g.map((p) => Math.hypot(p.x - x, p.z - z)));
    out.push({ x, z, lat: mean("lat"), lng: mean("lng"), r0, kind: "hotspots" });
  }
  return out;
}

/**
 * Daily spread ellipses for every source, days 0..`day`. `boost` = demo-mode risk multiplier.
 * Rain: real rain is already in each day's risk; `rainOn(d)` adds demo storms for day d.
 */
export function spreadEllipses(sources: FireSource[], weather: WeatherGrid[], day: number, boost = 1, rainOn?: (d: number) => RainBlob[]): SpreadEllipse[] {
  const out: SpreadEllipse[] = [];
  for (const s of sources) {
    const cell = weatherAt(weather, s.lat, s.lng);
    if (!cell) continue;
    let head = 0, back = 0;
    for (let d = 0; d <= day; d++) {
      const w = cell.days[d];
      if (!w) break;
      const kmh = Number.isFinite(w.wind) ? w.wind : 0;
      const wet = rainOn ? blobDamping(blobRain(rainOn(d), s.x, s.z)) : 1;
      const h = headKmPerDay(Math.min(1, w.risk * boost * wet));
      const lb = lengthToBreadth(kmh);
      head += h;
      back += h / headBackRatio(lb);
      if (head + back < MIN_GROWTH_KM) continue;
      const { dx, dz } = downwind(Number.isFinite(w.windFrom) ? w.windFrom : 0, kmh);
      const a = (head + back) / 2 + s.r0, b = (head + back) / (2 * lb) + s.r0, off = (head - back) / 2;
      const cx = s.x + dx * off, cz = s.z + dz * off;
      out.push({ cx, cz, ux: dx, uz: dz, a, b, day: d, minX: cx - a, maxX: cx + a, minZ: cz - a, maxZ: cz + a });
    }
  }
  return out;
}

export function insideEllipse(e: SpreadEllipse, x: number, z: number): boolean {
  if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) return false;
  const dx = x - e.cx, dz = z - e.cz;
  const along = dx * e.ux + dz * e.uz, across = dz * e.ux - dx * e.uz;
  return (along / e.a) ** 2 + (across / e.b) ** 2 <= 1;
}
