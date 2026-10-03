/**
 * Which highway corridors are threatened by the fires burning now ("Corridors at risk").
 *
 * A fire beside a busy highway is a different problem from a fire beside a town: the road
 * is both an exposure (people driving into smoke) and, usually, the way everyone upstream
 * of it leaves. So a corridor is listed only when a fire is actually near it — the same
 * wind-shaped reach the map uses for everything else (world/spread.ts: 30 km in calm air,
 * up to ~51 km downwind) — or when it crosses a projected spread ellipse. Dry weather on
 * its own never lists a road; nobody has to leave because it is warm.
 *
 * How busy the road is then decides how much that proximity matters, from the volume
 * predicted for the day in question (data/traffic.ts).
 */
import { project } from "../geo/projection";
import { downwind, SPREAD_MAX_KM, spreadInfluence } from "../world/spread";
import type { Hotspot, Perimeter } from "./cwfis";
import { perimeterAt, reachScale, type FireGrowth } from "./fireHistory";
import { growthLookup, type GrowthField } from "../world/fireGrowth";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import { predictVolume, type Highway, type TrafficNetwork } from "./traffic";

/** At or below this, a road carries too little traffic to add to the risk (vehicles/day). */
export const QUIET_VOLUME = 500;
/** At or above this, a road is as busy as the scoring distinguishes (vehicles/day). */
export const BUSY_VOLUME = 50_000;
/** Threat at or above this lists a corridor. */
const LIST_AT = 0.3;
/** Commercial share (%) above which the traffic is worth calling out as freight. */
export const FREIGHT_SHARE = 20;

/** How busy a road is on a 0..1 scale — logarithmic, because volumes span three decades. */
export function exposure(volume: number): number {
  if (!(volume > QUIET_VOLUME)) return 0;
  return Math.min(1, Math.log(volume / QUIET_VOLUME) / Math.log(BUSY_VOLUME / QUIET_VOLUME));
}

export interface CorridorThreat {
  highway: Highway;
  /** Workspace index of the region the highway is in. */
  region: number;
  /** The threatened point on the corridor (its closest approach to a fire). */
  lat: number;
  lng: number;
  /** Vehicles per day predicted there on the day being scored. */
  volume: number;
  /** 0..1 */
  score: number;
  /** Distance to the nearest fire from that point (km); Infinity when only a projected path reaches it. */
  nearKm: number;
  /** Short reason, e.g. "fire 12 km NW" or "in projected path". */
  reason: string;
}

interface Inputs {
  networks: TrafficNetwork[];
  hotspots: Pick<Hotspot, "lat" | "lng">[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  day: number;
  /** Calendar date of `day`, for the seasonal part of the volume prediction. */
  date: Date;
  /** Demo-mode weather multiplier. */
  boost: number;
  spread: GrowthField | null;
  /** Per-fire growth calibration by perimeter id. */
  growth?: Record<string, FireGrowth>;
  now?: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Compass direction of (dx, dz) in world space (+X east, +Z south). */
const dirOf = (dx: number, dz: number) => COMPASS[Math.round(((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360 / 45) % 8];

export function corridorThreats(inp: Inputs): CorridorThreat[] {
  const now = inp.now ?? Date.now();
  if (!inp.networks.length) return [];

  // Fire points (projected, with that day's wind there): hotspots + active perimeter
  // vertices. Built exactly as data/communityRisk.ts does, so both lists agree on
  // where the fires are and how far each one reaches.
  const fires: { x: number; z: number; dx: number; dz: number; stretch: number; scale: number }[] = [];
  const growth = inp.growth ?? {};
  const calibrated = inp.perimeters.filter((p) => growth[p.id] && isPerimeterActive(p, now));
  const windAt = (lat: number, lng: number) => {
    const w = weatherAt(inp.weather, lat, lng)?.days[inp.day];
    const calm = !w || !Number.isFinite(w.windFrom) || !Number.isFinite(w.wind);
    return downwind(calm ? 0 : w.windFrom, calm ? 0 : w.wind);
  };
  for (const h of inp.hotspots) {
    const fire = calibrated.length ? perimeterAt(calibrated, h.lat, h.lng) : undefined;
    fires.push({ ...project(h.lat, h.lng), ...windAt(h.lat, h.lng), scale: fire ? reachScale(growth[fire.id].k) : 1 });
  }
  for (const p of inp.perimeters) {
    if (!isPerimeterActive(p, now)) continue;
    const ring = p.rings[0] ?? [];
    const step = Math.max(1, Math.floor(ring.length / 24)); // a couple of dozen edge points is plenty
    const scale = growth[p.id] ? reachScale(growth[p.id].k) : 1;
    for (let i = 0; i < ring.length; i += step) fires.push({ ...project(ring[i][1], ring[i][0]), ...windAt(ring[i][1], ring[i][0]), scale });
  }
  const spreadDay = growthLookup(inp.spread);
  if (!fires.length && !inp.spread?.cells.length) return [];

  // Fires bucketed on a SPREAD_MAX_KM grid. CWFIS covers the whole country, so a province's
  // road points would otherwise each be tested against every fire in Canada; this way a
  // point only looks at the nine cells that can reach it.
  const cell = SPREAD_MAX_KM;
  const buckets = new Map<number, typeof fires>();
  const bucketKey = (bx: number, bz: number) => bx * 100003 + bz;
  for (const f of fires) {
    const k = bucketKey(Math.floor(f.x / cell), Math.floor(f.z / cell));
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(f);
  }

  // Worst point per highway, so a 500 km route is one entry rather than 250.
  const worst = new Map<string, CorridorThreat>();
  for (const net of inp.networks) {
    for (let i = 0; i < net.hwy.length; i++) {
      const x = net.x[i], z = net.z[i];
      const inPath = spreadDay(x, z) >= 0;

      let near = Infinity, nearDx = 0, nearDz = 0, influence = 0;
      const bx = Math.floor(x / cell), bz = Math.floor(z / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          for (const f of buckets.get(bucketKey(bx + ox, bz + oz)) ?? []) {
            const vx = x - f.x, vz = z - f.z;
            if (Math.abs(vx) > SPREAD_MAX_KM || Math.abs(vz) > SPREAD_MAX_KM) continue;
            const d = Math.hypot(vx, vz);
            if (d < near) { near = d; nearDx = -vx; nearDz = -vz; }
            influence = Math.max(influence, spreadInfluence(vx, vz, f));
          }
        }
      }
      if (influence <= 0 && !inPath) continue;

      const highway = net.highways[net.hwy[i]];
      if (!highway) continue;
      const volume = predictVolume(net, i, inp.date);
      const ex = exposure(volume);
      const wx = Math.min(1, (weatherAt(inp.weather, net.lat[i], net.lng[i])?.days[inp.day]?.risk ?? 0) * inp.boost);

      let score = 0, reason = "";
      if (inPath) { score = 0.9 + 0.1 * ex; reason = "in projected path"; }
      if (influence > 0) {
        // A busy road close to a fire in bad fire weather is the case that matters; a quiet
        // one still registers, just lower.
        const s = influence * (0.55 + 0.45 * ex) * (0.8 + 0.2 * wx);
        if (s > score) { score = s; reason = `fire ${Math.max(1, Math.round(near))} km ${dirOf(nearDx, nearDz)}`; }
      }
      if (score < LIST_AT) continue;

      const key = `${net.region}-${highway.n}-${highway.cls}`;
      const prev = worst.get(key);
      if (!prev || score > prev.score) {
        worst.set(key, { highway, region: net.region, lat: net.lat[i], lng: net.lng[i], volume, score, nearKm: near, reason });
      }
    }
  }
  return [...worst.values()].sort((a, b) => b.score - a.score || b.volume - a.volume);
}
