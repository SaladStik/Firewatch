/**
 * Duty incident board: active fires with operator status, size, values at risk,
 * and last update. Status can be overridden locally; suggestions come from size /
 * growth / hotspot activity.
 */
import { project } from "../geo/projection";
import type { Hotspot, Perimeter } from "./cwfis";
import type { CriticalAsset } from "./criticalAssets";
import type { FireGrowth } from "./fireHistory";
import { isPerimeterActive } from "./hazards";
import { valuesAtRisk } from "./valuesAtRisk";
import type { GrowthField } from "../world/fireGrowth";
import type { WeatherGrid } from "./openMeteo";
import type { Place } from "./places";

export type IncidentStatus = "monitor" | "ia" | "sustained" | "contained";

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  monitor: "Monitor",
  ia: "IA",
  sustained: "Sustained",
  contained: "Contained",
};

export const INCIDENT_STATUS_ORDER: IncidentStatus[] = ["ia", "sustained", "monitor", "contained"];

export interface Incident {
  id: string;
  /** Display name (nearest town or short id). */
  name: string;
  lat: number;
  lng: number;
  areaHa: number;
  hotspotCount: number;
  /** Suggested from behaviour. */
  suggested: IncidentStatus;
  /** Operator override when set. */
  override: IncidentStatus | null;
  /** Effective status (override ?? suggested). */
  status: IncidentStatus;
  /** Critical assets within planning distance. */
  valuesAtRisk: number;
  /** ISO timestamp of last perimeter/hotspot update. */
  lastUpdate: string;
  region?: number;
  kind: "perimeter" | "cluster";
}

export interface IncidentInputs {
  perimeters: Perimeter[];
  hotspots: Hotspot[];
  places: (Place & { region: number })[];
  weather: WeatherGrid[];
  day: number;
  spread: GrowthField | null;
  growth: Record<string, FireGrowth>;
  assets: CriticalAsset[];
  /** fire id → operator status */
  overrides: Record<string, IncidentStatus>;
  now?: number;
  focusRegions?: Set<number>;
}

const CLUSTER_KM = 8;
const STATUS_KEY = "firewatch.incident.status";

export function loadIncidentOverrides(): Record<string, IncidentStatus> {
  try {
    const v = JSON.parse(localStorage.getItem(STATUS_KEY) ?? "{}");
    if (!v || typeof v !== "object") return {};
    const out: Record<string, IncidentStatus> = {};
    for (const [k, s] of Object.entries(v)) {
      if (s === "monitor" || s === "ia" || s === "sustained" || s === "contained") out[k] = s;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveIncidentOverrides(overrides: Record<string, IncidentStatus>) {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(overrides)); } catch { /* ignore */ }
}

function centroid(p: Perimeter): { lat: number; lng: number } {
  const ring = p.rings[0] ?? [];
  if (!ring.length) return { lat: 0, lng: 0 };
  let slat = 0, slng = 0;
  for (const [lng, lat] of ring) { slat += lat; slng += lng; }
  return { lat: slat / ring.length, lng: slng / ring.length };
}

function nearestPlace(lat: number, lng: number, places: IncidentInputs["places"]): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const p of places) {
    if (p.landmark) continue;
    const d = Math.hypot((p.lat - lat) * 111, (p.lng - lng) * 111 * Math.cos((lat * Math.PI) / 180));
    if (d < bestD) { bestD = d; best = p.name; }
  }
  return bestD < 80 ? best : null;
}

function suggestStatus(areaHa: number, hotspotCount: number, growth?: FireGrowth): IncidentStatus {
  if (growth && growth.confidence >= 0.35 && growth.k < 0.55 && growth.observedKmDay < 0.15) return "contained";
  if (areaHa >= 2_000 || hotspotCount >= 35) return "sustained";
  if (areaHa > 0 && areaHa < 250) return "ia";
  if (areaHa === 0 && hotspotCount > 0 && hotspotCount < 12) return "ia";
  return "monitor";
}

function varCount(
  lat: number,
  lng: number,
  assets: CriticalAsset[],
  hotspots: Hotspot[],
  perimeters: Perimeter[],
  weather: WeatherGrid[],
  day: number,
  spread: GrowthField | null,
  growth: Record<string, FireGrowth>,
): number {
  if (!assets.length) return 0;
  return valuesAtRisk({
    lat, lng, assets, hotspots, perimeters, weather, day, spread, growth,
  }).items.length;
}

/** Cluster orphan hotspots (not on an active perimeter) into synthetic incidents. */
function clusterHotspots(
  hotspots: Hotspot[],
  covered: Set<string>,
  places: IncidentInputs["places"],
  focus?: Set<number>,
): Omit<Incident, "suggested" | "override" | "status" | "valuesAtRisk">[] {
  const free = hotspots.filter((h) => {
    if (h.agency === "SIMULATION") return false;
    if (covered.has(h.id)) return false;
    if (focus && h.region != null && !focus.has(h.region)) return false;
    return true;
  });
  const used = new Set<number>();
  const out: Omit<Incident, "suggested" | "override" | "status" | "valuesAtRisk">[] = [];
  for (let i = 0; i < free.length; i++) {
    if (used.has(i)) continue;
    const seed = free[i];
    const members = [seed];
    used.add(i);
    const s = project(seed.lat, seed.lng);
    for (let j = i + 1; j < free.length; j++) {
      if (used.has(j)) continue;
      const o = project(free[j].lat, free[j].lng);
      if (Math.hypot(o.x - s.x, o.z - s.z) <= CLUSTER_KM) {
        used.add(j);
        members.push(free[j]);
      }
    }
    const lat = members.reduce((a, h) => a + h.lat, 0) / members.length;
    const lng = members.reduce((a, h) => a + h.lng, 0) / members.length;
    const near = nearestPlace(lat, lng, places);
    const last = members.map((h) => h.time).sort().at(-1) ?? new Date().toISOString();
    out.push({
      id: `cluster:${seed.id}`,
      name: near ? `Near ${near}` : `Hotspot cluster`,
      lat, lng,
      areaHa: 0,
      hotspotCount: members.length,
      lastUpdate: last,
      region: seed.region,
      kind: "cluster",
    });
  }
  return out;
}

/** Build the incident board for focused regions. */
export function buildIncidents(inp: IncidentInputs): Incident[] {
  const now = inp.now ?? Date.now();
  const focus = inp.focusRegions;
  const covered = new Set<string>();
  const draft: Omit<Incident, "suggested" | "override" | "status" | "valuesAtRisk">[] = [];

  for (const p of inp.perimeters) {
    if (!isPerimeterActive(p, now)) continue;
    if (focus && p.region != null && !focus.has(p.region)) continue;
    const c = centroid(p);
    const near = nearestPlace(c.lat, c.lng, inp.places);
    // Mark hotspots inside this perimeter as covered for clustering.
    for (const h of inp.hotspots) {
      const d = Math.hypot((h.lat - c.lat) * 111, (h.lng - c.lng) * 111 * Math.cos((c.lat * Math.PI) / 180));
      if (d < 25) covered.add(h.id);
    }
    const nearbyHs = inp.hotspots.filter((h) => {
      const d = Math.hypot((h.lat - c.lat) * 111, (h.lng - c.lng) * 111 * Math.cos((c.lat * Math.PI) / 180));
      return d < 25;
    }).length;
    draft.push({
      id: p.id,
      name: near ? `Fire · ${near}` : `Fire ${p.id.slice(0, 12)}`,
      lat: c.lat,
      lng: c.lng,
      areaHa: p.areaHa,
      hotspotCount: Math.max(p.hotspotCount, nearbyHs),
      lastUpdate: p.lastDate,
      region: p.region,
      kind: "perimeter",
    });
  }

  draft.push(...clusterHotspots(inp.hotspots, covered, inp.places, focus));

  const incidents: Incident[] = draft.map((d) => {
    const g = inp.growth[d.id];
    const suggested = suggestStatus(d.areaHa, d.hotspotCount, g);
    const override = inp.overrides[d.id] ?? null;
    const status = override ?? suggested;
    const values = varCount(
      d.lat, d.lng, inp.assets, inp.hotspots, inp.perimeters,
      inp.weather, inp.day, inp.spread, inp.growth,
    );
    return { ...d, suggested, override, status, valuesAtRisk: values };
  });

  const rank = (s: IncidentStatus) => INCIDENT_STATUS_ORDER.indexOf(s);
  return incidents.sort((a, b) =>
    rank(a.status) - rank(b.status) || b.areaHa - a.areaHa || b.hotspotCount - a.hotspotCount,
  );
}
