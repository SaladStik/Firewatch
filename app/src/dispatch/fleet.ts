/**
 * Wildfire dispatch: which crew, helicopter or aircraft goes to each fire on the crew list, and
 * when it gets there.
 *
 * Bases are Alberta Wildfire's airtanker bases and forest-area headquarters (their airports).
 * How many of each resource sits at each base isn't published, so the fleet is illustrative and
 * adjustable; speeds and getaway times are typical values for each resource type.
 *
 * The rules a duty officer would apply, in priority order of the fires:
 *   - every fire gets a ground crew: a helitack crew (initial attack) while it's small
 *     (≤ 10 ha), a 20-person unit crew once it's bigger (sustained action);
 *   - fast or crowning fires (≥ 15 m/min, or crown) also get air: a skimmer group if there's a
 *     lake big enough to scoop within 30 km, otherwise an air tanker group;
 *   - each resource goes to the fire it reaches first among those that need it (nearest free one).
 */
import { haversineKm } from "./csv";
import type { Scored } from "./crews";

export interface Base { id: string; name: string; lat: number; lng: number }

export const BASES: Base[] = [
  { id: "SPR", name: "Calgary (Springbank)", lat: 51.103, lng: -114.374 },
  { id: "RMH", name: "Rocky Mountain House", lat: 52.430, lng: -114.904 },
  { id: "EDS", name: "Edson", lat: 53.579, lng: -116.465 },
  { id: "WTC", name: "Whitecourt", lat: 54.144, lng: -115.787 },
  { id: "GPR", name: "Grande Prairie", lat: 55.180, lng: -118.885 },
  { id: "PRV", name: "Peace River", lat: 56.227, lng: -117.447 },
  { id: "HLV", name: "High Level", lat: 58.621, lng: -117.164 },
  { id: "SLK", name: "Slave Lake", lat: 55.293, lng: -114.777 },
  { id: "LLB", name: "Lac La Biche", lat: 54.770, lng: -112.032 },
  { id: "FMM", name: "Fort McMurray", lat: 56.653, lng: -111.222 },
  { id: "PIN", name: "Pincher Creek", lat: 49.520, lng: -113.997 },
  { id: "FCH", name: "Fort Chipewyan", lat: 58.767, lng: -111.117 },
];

export type ResourceKind = "helitack" | "unit" | "airtanker" | "skimmer";

export const KIND: Record<ResourceKind, { label: string; short: string; speedKmh: number; getawayMin: number; road?: boolean; note: string }> = {
  helitack: { label: "Helitack crew", short: "HAC", speedKmh: 200, getawayMin: 15, note: "4–8 firefighters with a helicopter: initial attack" },
  unit: { label: "Unit crew", short: "Unit", speedKmh: 70, getawayMin: 30, road: true, note: "20 firefighters: sustained action; by road when close, flown in to remote fires" },
  airtanker: { label: "Air tanker group", short: "Tanker", speedKmh: 450, getawayMin: 15, note: "retardant; reloads at its base" },
  skimmer: { label: "Skimmer group", short: "Skimmer", speedKmh: 300, getawayMin: 15, note: "CL-415s scooping water from a lake" },
};

/** Default fleet per base (illustrative): where each kind of resource is stationed. */
const STATIONED: Record<ResourceKind, string[]> = {
  helitack: BASES.map((b) => b.id),
  unit: ["SPR", "RMH", "EDS", "WTC", "GPR", "PRV", "SLK", "LLB", "FMM", "PIN"],
  airtanker: ["SPR", "RMH", "EDS", "GPR", "HLV", "SLK", "LLB", "FMM"],
  skimmer: ["SLK", "LLB", "HLV"],
};

export interface Resource { id: string; kind: ResourceKind; base: Base }
export interface FleetSize { helitack: number; unit: number; airtanker: number; skimmer: number }

/** Spread `n` resources of a kind across its bases, round-robin. */
export function makeFleet(size: FleetSize): Resource[] {
  const out: Resource[] = [];
  for (const kind of Object.keys(STATIONED) as ResourceKind[]) {
    const bases = STATIONED[kind].map((id) => BASES.find((b) => b.id === id)!);
    for (let i = 0; i < size[kind]; i++) {
      const base = bases[i % bases.length];
      out.push({ id: `${KIND[kind].short}-${base.id}-${Math.floor(i / bases.length) + 1}`, kind, base });
    }
  }
  return out;
}

/** Beyond this, unit crews are flown in (fixed-wing / helicopter) rather than driven. */
export const FLY_IN_KM = 100;

/** Minutes for a resource to reach a point from its base. */
export function etaMin(r: Resource, lat: number, lng: number): number {
  const k = KIND[r.kind], km = haversineKm(r.base.lat, r.base.lng, lat, lng);
  // Unit crews drive (roads wind: × 1.3) when close; remote fires get them flown in at ~250 km/h
  // after a longer mobilization (crew, gear and aircraft).
  if (r.kind === "unit" && km > FLY_IN_KM) return 60 + (km / 250) * 60;
  return k.getawayMin + ((km * (k.road ? 1.3 : 1)) / k.speedKmh) * 60;
}

export interface Lake { lat: number; lng: number; km: number }

export interface Assignment {
  resource: Resource;
  /** Minutes from dispatch to arrival over the fire. */
  eta: number;
  /** Air: minutes per round trip (fire → water or base → fire), and drops per hour. */
  cycleMin?: number;
  dropsPerHour?: number;
  /** Skimmers: the lake they scoop from. */
  lake?: Lake;
  why: string;
}

export interface FireDispatch { fire: Scored; assignments: Assignment[]; unmet: string[] }

/** Thresholds for the rules above. */
export const IA_MAX_HA = 10, AIR_ROS = 15, LAKE_MAX_KM = 30;

/**
 * Dispatch the fleet to the crewed fires, in their priority order. `lakeFor` gives the nearest
 * scoopable lake for a fire (null if none within LAKE_MAX_KM).
 */
export function dispatchFleet(fires: Scored[], fleet: Resource[], lakeFor: (s: Scored) => Lake | null): FireDispatch[] {
  const free = new Set(fleet);
  const take = (kind: ResourceKind, lat: number, lng: number) => {
    let best: Resource | null = null, bestEta = Infinity;
    for (const r of free) if (r.kind === kind) { const e = etaMin(r, lat, lng); if (e < bestEta) { bestEta = e; best = r; } }
    if (best) free.delete(best);
    return best ? { r: best, eta: bestEta } : null;
  };
  return fires.map((s) => {
    const { lat, lng } = s.fire, out: Assignment[] = [], unmet: string[] = [];
    // Ground: helitack for initial attack while small, a unit crew for a bigger fire; the other if none is free.
    const want: ResourceKind = s.fire.sizeHa <= IA_MAX_HA ? "helitack" : "unit";
    const ground = take(want, lat, lng) ?? take(want === "helitack" ? "unit" : "helitack", lat, lng);
    if (ground) out.push({ resource: ground.r, eta: ground.eta, why: ground.r.kind === "helitack" ? `initial attack (${s.fire.sizeHa <= IA_MAX_HA ? "small fire" : "no unit crew free"})` : `sustained action (${s.fire.sizeHa > IA_MAX_HA ? "over 10 ha" : "no helitack free"})` });
    else unmet.push("no ground crew free");
    // Air: fast or crowning fires.
    if (s.ros >= AIR_ROS || s.fire.crown) {
      const lake = lakeFor(s);
      const air = (lake && take("skimmer", lat, lng)) || take("airtanker", lat, lng);
      if (air) {
        const k = KIND[air.r.kind];
        const legKm = air.r.kind === "skimmer" && lake ? lake.km : haversineKm(air.r.base.lat, air.r.base.lng, lat, lng);
        const cycle = (2 * legKm / k.speedKmh) * 60 + (air.r.kind === "skimmer" ? 2 : 20); // scoop ~2 min; reload ~20 min
        out.push({
          resource: air.r, eta: air.eta, cycleMin: cycle, dropsPerHour: 60 / cycle, ...(air.r.kind === "skimmer" && lake ? { lake } : {}),
          why: `${s.fire.crown ? "crown fire" : `spreading ${Math.round(s.ros)} m/min`}${air.r.kind === "skimmer" && lake ? `, lake ${lake.km.toFixed(0)} km away` : lake ? ", no skimmer free" : ", no lake to scoop nearby"}`,
        });
      } else unmet.push("no aircraft free");
    }
    return { fire: s, assignments: out, unmet };
  });
}
