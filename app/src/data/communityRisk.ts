/**
 * Which communities are actually threatened (the forecast bar's "Communities at risk").
 *
 * A town makes the list only for a concrete reason:
 *   - a fire is near: a hotspot or active perimeter within the wind-shaped reach the map
 *     uses (world/spread.ts: 30 km in calm air, up to ~51 km downwind), or
 *   - it's inside a projected spread ellipse (demo scenario), or
 *   - its fire weather alone is High or worse (same thresholds as the map colours).
 * Plain "warm and dry somewhere" never puts a town on the list.
 */
import { project } from "../geo/projection";
import { downwind, SPREAD_MAX_KM, spreadInfluence } from "../world/spread";
import type { Hotspot, Perimeter } from "./cwfis";
import { perimeterAt, reachScale, type FireGrowth } from "./fireHistory";
import { insideEllipse, type SpreadEllipse } from "./fireSpread";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import type { Place } from "./places";

/** Fire weather at or above this (0..1) is "High" on the map; enough on its own to list a town. */
export const HIGH_WEATHER = 0.68;
/** Threat at or above this lists a town. */
const LIST_AT = 0.3;

export interface CommunityThreat {
  place: Place & { region: number };
  /** 0..1 */
  score: number;
  /** Short reason, e.g. "fire 18 km W", "in projected path", "high fire weather". */
  reason: string;
}

interface Inputs {
  places: (Place & { region: number })[];
  hotspots: Pick<Hotspot, "lat" | "lng">[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  day: number;
  /** Demo-mode weather multiplier. */
  boost: number;
  spread: SpreadEllipse[];
  /** Per-fire growth calibration by perimeter id. */
  growth?: Record<string, FireGrowth>;
  now?: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Compass direction of (dx, dz) in world space (+X east, +Z south). */
const dirOf = (dx: number, dz: number) => COMPASS[Math.round(((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360 / 45) % 8];

export function communityThreats(inp: Inputs): CommunityThreat[] {
  const now = inp.now ?? Date.now();
  // Fire points (projected, with that day's wind there): hotspots + active perimeter vertices.
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

  const out: CommunityThreat[] = [];
  for (const place of inp.places) {
    const { x, z } = project(place.lat, place.lng);
    // Nearest fire, and the strongest wind-shaped influence of any fire on this town.
    let near = Infinity, nearDx = 0, nearDz = 0, influence = 0;
    for (const f of fires) {
      const vx = x - f.x, vz = z - f.z;
      if (Math.abs(vx) > SPREAD_MAX_KM || Math.abs(vz) > SPREAD_MAX_KM) continue;
      const d = Math.hypot(vx, vz);
      if (d < near) { near = d; nearDx = -vx; nearDz = -vz; }
      influence = Math.max(influence, spreadInfluence(vx, vz, f));
    }
    const wx = Math.min(1, (weatherAt(inp.weather, place.lat, place.lng)?.days[inp.day]?.risk ?? 0) * inp.boost);
    const inPath = inp.spread.some((e) => insideEllipse(e, x, z));

    let score = 0, reason = "";
    if (inPath) { score = 0.9 + 0.1 * wx; reason = "in projected path"; }
    if (influence > 0) {
      // Closer / downwind fires matter more, and more so in bad fire weather.
      const s = influence * (0.65 + 0.35 * wx);
      if (s > score) { score = s; reason = `fire ${Math.max(1, Math.round(near))} km ${dirOf(nearDx, nearDz)}`; }
    }
    if (wx >= HIGH_WEATHER && wx * 0.75 > score) { score = wx * 0.75; reason = wx >= 0.85 ? "extreme fire weather" : "high fire weather"; }
    if (score >= LIST_AT) out.push({ place, score, reason });
  }
  return out.sort((a, b) => b.score - a.score || b.place.pop - a.place.pop);
}
