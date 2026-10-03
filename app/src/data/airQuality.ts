/**
 * Smoke / air-quality advisories for communities near fire-possible areas.
 *
 * This is not an official AQHI feed. It estimates wildfire-smoke exposure from the
 * same signals the map already uses: wind-shaped reach around hotspots and active
 * perimeters (world/spread.ts), projected fire path, and fire intensity (FRP).
 * Towns only appear when smoke from a real fire (or projected path) can reach them —
 * dry weather alone never triggers an air-quality alert.
 */
import { project } from "../geo/projection";
import { NodeStatus } from "../hex/nodeTypes";
import { downwind, SPREAD_MAX_KM, spreadInfluence } from "../world/spread";
import type { Hotspot, Perimeter } from "./cwfis";
import { perimeterAt, reachScale, type FireGrowth } from "./fireHistory";
import { growthLookup, type GrowthField } from "../world/fireGrowth";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import type { Place } from "./places";

/** Threat at or above this lists a community. */
const LIST_AT = 0.28;
/** FRP (MW) that counts as a strongly smoking fire for intensity scaling. */
const STRONG_FRP = 80;

export type AirLevel = "Good" | "Moderate" | "High" | "Very High" | "Extreme";

/** Smoke reading at any map point (clicked hex or community). */
export interface AirReading {
  lat: number;
  lng: number;
  /** 0..1 smoke exposure score. */
  score: number;
  /** Rough AQHI-style band (1–10+), derived from score. */
  aqhi: number;
  level: AirLevel;
  /** Short reason, e.g. "smoke 12 km SW", "in projected smoke path", "clear". */
  reason: string;
  /** True when score is high enough for an advisory. */
  advisory: boolean;
}

export interface AirThreat extends AirReading {
  place: Place & { region: number };
}

interface Inputs {
  places: (Place & { region: number })[];
  hotspots: Pick<Hotspot, "lat" | "lng" | "frp">[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  day: number;
  spread: GrowthField | null;
  growth?: Record<string, FireGrowth>;
  now?: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const dirOf = (dx: number, dz: number) =>
  COMPASS[Math.round((((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360) / 45) % 8];

/** Map 0..1 smoke score → AQHI-style integer and Alberta-like band label. */
export function airLevel(score: number): { aqhi: number; level: AirLevel } {
  const aqhi = Math.max(1, Math.min(11, Math.round(1 + score * 10)));
  if (score < 0.12) return { aqhi: Math.min(aqhi, 2), level: "Good" };
  if (score >= 0.85) return { aqhi, level: "Extreme" };
  if (score >= 0.68) return { aqhi, level: "Very High" };
  if (score >= 0.5) return { aqhi, level: "High" };
  return { aqhi, level: "Moderate" };
}

/** Intensity 0..1 from fire radiative power (MW). */
function intensity(frp: number | undefined): number {
  if (!Number.isFinite(frp) || (frp ?? 0) <= 0) return 0.45;
  return Math.min(1, 0.35 + 0.65 * Math.min(1, (frp as number) / STRONG_FRP));
}

type FirePt = { x: number; z: number; dx: number; dz: number; stretch: number; scale: number; frp: number };

function firePoints(inp: Omit<Inputs, "places">): FirePt[] {
  const now = inp.now ?? Date.now();
  const growth = inp.growth ?? {};
  const calibrated = inp.perimeters.filter((p) => growth[p.id] && isPerimeterActive(p, now));

  const windAt = (lat: number, lng: number) => {
    const w = weatherAt(inp.weather, lat, lng)?.days[inp.day];
    const calm = !w || !Number.isFinite(w.windFrom) || !Number.isFinite(w.wind);
    // Calm near a fire traps smoke; still give a mild stretch so plumes exist.
    return downwind(calm ? 0 : w.windFrom, calm ? 4 : w.wind);
  };

  const fires: FirePt[] = [];
  for (const h of inp.hotspots) {
    const fire = calibrated.length ? perimeterAt(calibrated, h.lat, h.lng) : undefined;
    fires.push({
      ...project(h.lat, h.lng),
      ...windAt(h.lat, h.lng),
      scale: fire ? reachScale(growth[fire.id].k) : 1,
      frp: h.frp ?? 0,
    });
  }
  for (const p of inp.perimeters) {
    if (!isPerimeterActive(p, now)) continue;
    const ring = p.rings[0] ?? [];
    const step = Math.max(1, Math.floor(ring.length / 24));
    const scale = growth[p.id] ? reachScale(growth[p.id].k) : 1;
    for (let i = 0; i < ring.length; i += step) {
      const [lng, lat] = ring[i];
      fires.push({ ...project(lat, lng), ...windAt(lat, lng), scale, frp: 40 });
    }
  }
  return fires;
}

/** Smoke reading at a clicked (or any) lat/lng. */
export function airAt(
  lat: number,
  lng: number,
  inp: Omit<Inputs, "places">,
): AirReading {
  const fires = firePoints(inp);
  const { x, z } = project(lat, lng);
  let near = Infinity, nearDx = 0, nearDz = 0, smoke = 0;
  for (const f of fires) {
    const vx = x - f.x, vz = z - f.z;
    if (Math.abs(vx) > SPREAD_MAX_KM || Math.abs(vz) > SPREAD_MAX_KM) continue;
    const d = Math.hypot(vx, vz);
    if (d < near) { near = d; nearDx = -vx; nearDz = -vz; }
    smoke = Math.max(smoke, spreadInfluence(vx, vz, f) * intensity(f.frp));
  }
  const inPath = growthLookup(inp.spread)(x, z) >= 0;
  const wx = weatherAt(inp.weather, lat, lng)?.days[inp.day];
  const trap = wx && Number.isFinite(wx.wind) ? 1 + 0.25 * (1 - Math.min(1, wx.wind / 35)) : 1;

  let score = smoke * trap;
  let reason = "clear";
  if (smoke > 0) reason = `smoke ${Math.max(1, Math.round(near))} km ${dirOf(nearDx, nearDz)}`;
  if (inPath) {
    score = Math.max(score, 0.82);
    reason = smoke > 0 ? reason : "in projected smoke path";
  }
  score = Math.min(1, score);
  const { aqhi, level } = airLevel(score);
  return {
    lat,
    lng,
    score,
    aqhi,
    level,
    reason: score < 0.12 ? "clear" : reason,
    advisory: score >= LIST_AT,
  };
}

export function airThreats(inp: Inputs): AirThreat[] {
  const { places, ...rest } = inp;
  const out: AirThreat[] = [];
  for (const place of places) {
    const reading = airAt(place.lat, place.lng, rest);
    if (!reading.advisory) continue;
    out.push({ ...reading, place });
  }
  return out.sort((a, b) => b.score - a.score || b.place.pop - a.place.pop);
}

/** Hex statuses that count as fire-possible for the air-quality map haze. */
export const AIR_HAZE_STATUSES = new Set<number>([
  NodeStatus.Elevated,
  NodeStatus.High,
  NodeStatus.Extreme,
  NodeStatus.Burning,
  NodeStatus.Perimeter,
  NodeStatus.Projected,
]);
