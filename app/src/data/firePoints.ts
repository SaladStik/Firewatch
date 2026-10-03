/**
 * Which heat counts as fire, in one place, so the map, Firefly and every panel agree.
 *
 * Agency-reported fires are the source of truth (reportedFires.ts). Satellite hotspots are
 * unconfirmed heat: a weak cluster that sits mostly on farmland, with no reported fire near it, is
 * most likely a stubble or slash burn and doesn't count. Everything else does, and every reported
 * fire that's still burning counts even when no satellite saw it.
 *
 * Used for the map's risk near fire, communities at risk, smoke, highways, values at risk, the
 * incident board and the stations. Projected spread uses reported fires only (fireSpread.ts).
 */
import { project } from "../geo/projection";
import type { Hotspot, Perimeter } from "./cwfis";
import { fireSources, type FireSource } from "./fireSpread";
import type { ReportedFire } from "./reportedFires";

/** A cluster this weak and mostly on farmland is most likely a stubble or slash burn. */
export const FARM_SHARE = 0.5, FARM_MAX_FRP_MW = 25;
/** A reported fire within this far of a cluster (km, beyond both radii) makes it a real fire. */
const OFFICIAL_NEAR_KM = 5;

type Reported = Pick<ReportedFire, "id" | "lat" | "lng" | "sizeHa" | "stage" | "agency" | "statusDate"> & { region?: number };

const radiusKm = (ha: number) => Math.sqrt(ha / 100 / Math.PI);
const burning = (f: Pick<ReportedFire, "stage">) => f.stage !== "under_control";

/** One cluster of satellite heat, with what decides whether it's a fire. */
export interface HeatCluster extends FireSource {
  members: Hotspot[];
  farmShare: number;
  maxFrpMw: number;
  /** The reported fire it belongs to, if any. */
  official: Reported | null;
  likelyFarmOrControlledBurn: boolean;
}

/** Cluster real hotspots (perimeters first) and judge each one. */
export function heatClusters(hotspots: Hotspot[], reported: Reported[], perimeters: Perimeter[], now = Date.now(), growth: Record<string, { k: number }> = {}): HeatCluster[] {
  const real = hotspots.filter((h) => h.agency !== "SIMULATION");
  const pts = real.map((h) => ({ h, ...project(h.lat, h.lng) }));
  const fires = reported.map((f) => ({ f, ...project(f.lat, f.lng), r0: radiusKm(f.sizeHa) }));
  return fireSources(real, perimeters, now, growth).map((c) => {
    const members = pts.filter((p) => Math.hypot(p.x - c.x, p.z - c.z) <= c.r0 + 1).map((p) => p.h);
    const farmShare = members.length ? members.filter((h) => h.fuel.toLowerCase() === "farm").length / members.length : 0;
    const maxFrpMw = members.reduce((m, h) => Math.max(m, h.frp || 0), 0);
    const official = fires.find((o) => Math.hypot(o.x - c.x, o.z - c.z) <= o.r0 + c.r0 + OFFICIAL_NEAR_KM)?.f ?? null;
    return {
      ...c, members, farmShare, maxFrpMw, official,
      likelyFarmOrControlledBurn: !official && c.kind === "hotspots" && farmShare >= FARM_SHARE && maxFrpMw < FARM_MAX_FRP_MW,
    };
  });
}

/**
 * The heat that counts as fire: hotspots minus likely farm burns, plus a point for every reported
 * fire still burning that no counted hotspot is near. Demo (SIMULATION) hotspots pass through.
 */
export function fireHotspots(hotspots: Hotspot[], reported: Reported[], perimeters: Perimeter[], now = Date.now()): Hotspot[] {
  const sims = hotspots.filter((h) => h.agency === "SIMULATION");
  const farm = new Set<string>();
  for (const c of heatClusters(hotspots, reported, perimeters, now)) {
    if (c.likelyFarmOrControlledBurn) for (const h of c.members) farm.add(h.id);
  }
  const kept = hotspots.filter((h) => h.agency !== "SIMULATION" && !farm.has(h.id));
  const keptPts = kept.map((h) => project(h.lat, h.lng));
  const unseen = reported.filter(burning).filter((f) => {
    const w = project(f.lat, f.lng), r = radiusKm(f.sizeHa) + OFFICIAL_NEAR_KM;
    return !keptPts.some((p) => Math.hypot(p.x - w.x, p.z - w.z) <= r);
  });
  return [
    ...kept,
    ...unseen.map((f): Hotspot => ({
      id: `reported-${f.id}`, lat: f.lat, lng: f.lng, time: f.statusDate || new Date(now).toISOString(),
      // No satellite measurement: smoke and reach use their middle values (frp 0 = unknown).
      frp: 0, fwi: 0, hfi: 0, fuel: "", sensor: "agency report", agency: f.agency, region: f.region,
    })),
    ...sims,
  ];
}
