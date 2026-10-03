/**
 * Values-at-risk near a selected fire (or selected map sector).
 *
 * Lists critical infrastructure (schools, hospitals, industrial, power) within
 * planning distance of the focus fire, scored with the same wind-reach + path
 * ideas as community risk — for duty checklists, not an official evac order.
 */
import { project } from "../geo/projection";
import { downwind, SPREAD_MAX_KM, spreadInfluence } from "../world/spread";
import type { Hotspot, Perimeter } from "./cwfis";
import { ASSET_KIND_ORDER, type CriticalAsset } from "./criticalAssets";
import { perimeterAt, reachScale, type FireGrowth } from "./fireHistory";
import { growthLookup, type GrowthField } from "../world/fireGrowth";
import { isPerimeterActive } from "./hazards";
import { weatherAt, type WeatherGrid } from "./openMeteo";

/** Assets farther than this from the focus fire never make the checklist. */
export const VAR_MAX_KM = 40;
/** Soft list floor so only meaningfully exposed assets show. */
const LIST_AT = 0.18;

export type ValueRiskKind = "fire" | "path" | "near";

export interface ValueAtRisk {
  asset: CriticalAsset;
  /** 0..1 exposure. */
  score: number;
  /** km from the focus fire (or sector if no fire). */
  km: number;
  /** Compass from fire toward the asset. */
  dir: string;
  reason: string;
  kind: ValueRiskKind;
}

export interface FireFocus {
  lat: number;
  lng: number;
  /** Short label for the UI, e.g. "hotspot" or perimeter id. */
  label: string;
}

interface Inputs {
  /** Selected hex (or other duty focus). */
  lat: number;
  lng: number;
  assets: CriticalAsset[];
  hotspots: Pick<Hotspot, "lat" | "lng" | "id" | "agency">[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  day: number;
  spread: GrowthField | null;
  growth?: Record<string, FireGrowth>;
  now?: number;
  /** Override max distance (km). */
  maxKm?: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const dirOf = (dx: number, dz: number) =>
  COMPASS[Math.round((((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360) / 45) % 8];

/** Nearest active fire to a map point — that fire drives the checklist. */
export function nearestFire(
  lat: number,
  lng: number,
  hotspots: Pick<Hotspot, "lat" | "lng" | "id" | "agency">[],
  perimeters: Perimeter[],
  now = Date.now(),
): FireFocus | null {
  const { x, z } = project(lat, lng);
  let best: FireFocus | null = null;
  let bestD = Infinity;

  for (const h of hotspots) {
    const p = project(h.lat, h.lng);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) {
      bestD = d;
      best = { lat: h.lat, lng: h.lng, label: "hotspot" };
    }
  }
  for (const per of perimeters) {
    if (!isPerimeterActive(per, now)) continue;
    // Use ring centroid as the fire focus.
    const ring = per.rings[0];
    if (!ring?.length) continue;
    let slat = 0, slng = 0;
    for (const [plng, plat] of ring) { slat += plat; slng += plng; }
    const clat = slat / ring.length, clng = slng / ring.length;
    const p = project(clat, clng);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) {
      bestD = d;
      best = { lat: clat, lng: clng, label: per.id.slice(0, 18) };
    }
  }
  // Nothing within a generous search — treat the sector itself as the focus.
  if (!best || bestD > 120) return { lat, lng, label: "this sector" };
  return best;
}

/**
 * Critical assets exposed near the fire closest to (lat, lng).
 * Sorted worst-first, then by life-safety kind order.
 */
export function valuesAtRisk(inp: Inputs): { focus: FireFocus; items: ValueAtRisk[] } {
  const now = inp.now ?? Date.now();
  const maxKm = inp.maxKm ?? VAR_MAX_KM;
  const focus = nearestFire(inp.lat, inp.lng, inp.hotspots, inp.perimeters, now);
  const fire = focus!;
  const growth = inp.growth ?? {};
  const calibrated = inp.perimeters.filter((p) => growth[p.id] && isPerimeterActive(p, now));

  const windAt = (lat: number, lng: number) => {
    const w = weatherAt(inp.weather, lat, lng)?.days[inp.day];
    const calm = !w || !Number.isFinite(w.windFrom) || !Number.isFinite(w.wind);
    return downwind(calm ? 0 : w.windFrom, calm ? 0 : w.wind);
  };

  const fires: { x: number; z: number; dx: number; dz: number; stretch: number; scale: number }[] = [];
  for (const h of inp.hotspots) {
    const f = calibrated.length ? perimeterAt(calibrated, h.lat, h.lng) : undefined;
    fires.push({ ...project(h.lat, h.lng), ...windAt(h.lat, h.lng), scale: f ? reachScale(growth[f.id].k) : 1 });
  }
  for (const p of inp.perimeters) {
    if (!isPerimeterActive(p, now)) continue;
    const ring = p.rings[0] ?? [];
    const step = Math.max(1, Math.floor(ring.length / 24));
    const scale = growth[p.id] ? reachScale(growth[p.id].k) : 1;
    for (let i = 0; i < ring.length; i += step) {
      const [lng, lat] = ring[i];
      fires.push({ ...project(lat, lng), ...windAt(lat, lng), scale });
    }
  }
  // Always include the focus point so sector-only mode still distances correctly.
  fires.push({ ...project(fire.lat, fire.lng), ...windAt(fire.lat, fire.lng), scale: 1 });

  const origin = project(fire.lat, fire.lng);
  const spreadDay = growthLookup(inp.spread);
  const out: ValueAtRisk[] = [];

  for (const asset of inp.assets) {
    const { x, z } = project(asset.lat, asset.lng);
    const km = Math.hypot(x - origin.x, z - origin.z);
    if (km > maxKm) continue;

    let influence = 0;
    for (const f of fires) {
      const vx = x - f.x, vz = z - f.z;
      if (Math.abs(vx) > SPREAD_MAX_KM || Math.abs(vz) > SPREAD_MAX_KM) continue;
      influence = Math.max(influence, spreadInfluence(vx, vz, f));
    }
    const inPath = spreadDay(x, z) >= 0;
    const dir = dirOf(x - origin.x, z - origin.z);
    const nearScore = Math.max(0, 1 - km / maxKm);

    let score = nearScore * 0.45;
    let kind: ValueRiskKind = "near";
    let reason = `${Math.max(1, Math.round(km))} km ${dir}`;
    if (influence > 0) {
      const s = influence * 0.85 + nearScore * 0.15;
      if (s > score) { score = s; kind = "fire"; reason = `fire ${Math.max(1, Math.round(km))} km ${dir}`; }
    }
    if (inPath) {
      score = Math.max(score, 0.88);
      kind = "path";
      reason = "in projected path";
    }
    if (score < LIST_AT && kind === "near") continue;
    out.push({ asset, score: Math.min(1, score), km, dir, reason, kind });
  }

  const kindRank = (k: CriticalAsset["kind"]) => ASSET_KIND_ORDER.indexOf(k);
  out.sort((a, b) => b.score - a.score || kindRank(a.asset.kind) - kindRank(b.asset.kind) || a.km - b.km);
  return { focus: fire, items: out };
}
