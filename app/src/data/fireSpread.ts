/**
 * Fires to project, and the inputs the growth model needs for each (world/fireGrowth.ts).
 *
 * A fire is an active CWFIS perimeter, or a cluster of satellite hotspots (within 3 km of each
 * other) not already inside one. Each carries its current radius, its growth calibration `k`
 * (data/fireHistory.ts) and, per forecast day, the FWI System values and wind at the fire.
 * The projection itself runs on the fuel map in the worker.
 */
import { SEASONAL_CURING } from "./cffdrs";
import { project } from "../geo/projection";
import type { GrowthSource } from "../world/fireGrowth";
import type { Hotspot, Perimeter } from "./cwfis";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import { blobDamping, blobRain, type RainBlob } from "./rain";

/** Hotspots closer than this (km) are one fire. */
const CLUSTER_KM = 3;
/** Smallest radius given to a hotspot cluster (km; one satellite pixel ≈ 0.4 km). */
const MIN_R0_KM = 0.4;

export interface FireSource {
  x: number;
  z: number;
  lat: number;
  lng: number;
  /** Current fire radius (km). */
  r0: number;
  kind: "perimeter" | "hotspots";
  /** Growth calibration from this fire's own history (data/fireHistory.ts); 1 = model as is. */
  k: number;
  /** Perimeter id, when the source is a mapped perimeter. */
  id?: string;
}

export function fireSources(hotspots: Pick<Hotspot, "lat" | "lng">[], perimeters: Perimeter[], now = Date.now(), growth: Record<string, { k: number }> = {}): FireSource[] {
  const out: FireSource[] = [];
  for (const p of perimeters) {
    const ring = p.rings[0];
    if (!ring?.length || !isPerimeterActive(p, now)) continue;
    const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length, lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    out.push({ ...project(lat, lng), lat, lng, r0: Math.sqrt(p.areaHa / 100 / Math.PI), kind: "perimeter", id: p.id, k: growth[p.id]?.k ?? 1 });
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
    out.push({ x, z, lat: mean("lat"), lng: mean("lng"), r0, kind: "hotspots", k: 1 }); // new fires: no history yet
  }
  return out;
}


/**
 * Growth-model input per fire for days 0..`horizon`: that day's FWI values and wind at the fire,
 * seasonal grass curing, and the demo factors (heatwave `boost`, rainstorms over the fire).
 * Fires outside every weather grid are skipped (nothing to drive them with).
 */
export function growthSources(sources: FireSource[], weather: WeatherGrid[], horizon: number, boost = 1, stormsOn?: (d: number) => RainBlob[]): GrowthSource[] {
  const dates = weather[0]?.dates ?? [];
  const out: GrowthSource[] = [];
  for (const s of sources) {
    const cell = weatherAt(weather, s.lat, s.lng);
    if (!cell) continue;
    const days = [];
    for (let d = 0; d <= horizon; d++) {
      const w = cell.days[d];
      if (!w) break;
      const month = Number((dates[d] ?? "2000-07").slice(5, 7)) || 7;
      const wet = stormsOn ? blobDamping(blobRain(stormsOn(d), s.x, s.z)) : 1;
      days.push({ ffmc: w.ffmc, isi: w.isi, bui: w.bui, wind: w.windNoon ?? w.wind, windFrom: w.windFrom, curing: SEASONAL_CURING[month - 1], factor: boost * wet });
    }
    out.push({ x: s.x, z: s.z, r0: s.r0, k: s.k, days });
  }
  return out;
}
