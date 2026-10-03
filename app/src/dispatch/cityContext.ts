/**
 * Where a 311 ticket is, in terms that change how urgent it is. Built from
 * public/data/cases/calgary_context.json (scripts/bake_calgary_311.py):
 *   - Open Calgary 311 history: how long the city takes to close each type, repeat spots, how
 *     often each community reports each type;
 *   - community populations;
 *   - OpenStreetMap: schools, childcare, hospitals, seniors' homes, fire and police stations,
 *     transit stops, traffic signals, crossings;
 *   - slope from the 20 m city elevation;
 * plus, when the route planner's street network is loaded, the road the ticket is on.
 */
import { project } from "../geo/projection";
import { haversineKm } from "./csv";

export interface CityContextFile {
  baked: string;
  historyDays: number;
  historyRequests: number;
  closeTargets: Record<string, { median: number; p90: number; n: number }>;
  communityRequests: Record<string, Record<string, number>>;
  population: Record<string, number>;
  populationYear: number | null;
  repeatSpots: Record<string, [number, number, number][]>;
  poi: Record<string, [number, number][]>;
  slope: { minX: number; minZ: number; cellKm: number; w: number; h: number; scale: number; b64: string };
  /** Per community (scripts/bake-calgary-communities.ts). */
  communities?: Record<string, CommunityStats>;
}

/** One Calgary community, measured inside its boundary. */
export interface CommunityStats {
  kind: string;
  areaKm2: number;
  population: number;
  density: number;
  schools: number;
  childcare: number;
  seniors: number;
  hospitals: number;
  fireStations: number;
  /** Crosswalks + traffic signals per km² (how busy the streets are on foot). */
  crossingsPerKm2: number;
  transitPerKm2: number;
  slopeMean: number;
  /** Share of the community steeper than 8%. */
  slopeSteepShare: number;
}

/** The road a ticket sits on (from the route planner's network). */
export type RoadClass = "highway" | "arterial" | "collector" | "local" | "track";
export type RoadAt = (lat: number, lng: number) => { cls: RoadClass; metres: number } | null;

export interface Site {
  road: RoadClass | null;
  /** Nearest of each point kind (metres), when within its search radius. */
  near: Partial<Record<PoiKind, number>>;
  /** Ground slope (%). */
  slopePct: number | null;
  /** Requests of this same type in this 100 m spot over the last year. */
  repeats: number;
  /** This community's yearly requests of this type per 1,000 residents, against the city's middle community. */
  areaRate: number | null;
  areaRateMedian: number | null;
  /** The city's own 90th-percentile time to close this type (days). */
  closeP90: number | null;
}

export type PoiKind = "school" | "childcare" | "hospital" | "seniors" | "fire_station" | "police" | "transit" | "signal" | "crossing";
/** How far each kind of point counts from a ticket (m). */
const RADIUS: Record<PoiKind, number> = {
  school: 200, childcare: 150, hospital: 300, seniors: 150, fire_station: 500, police: 300, transit: 60, signal: 60, crossing: 40,
};

const CELL = 0.002; // degrees, ~ 220 m × 140 m
const cellKey = (la: number, ln: number) => Math.floor(la / CELL) * 1000003 + Math.floor(ln / CELL);

export class CityContext {
  readonly file: CityContextFile;
  private poi = new Map<PoiKind, Map<number, [number, number][]>>();
  private repeat = new Map<string, Map<string, number>>();
  private slope: Uint8Array;
  private rateMedian = new Map<string, number>();

  constructor(file: CityContextFile) {
    this.file = file;
    for (const [kind, pts] of Object.entries(file.poi) as [PoiKind, [number, number][]][]) {
      const grid = new Map<number, [number, number][]>();
      for (const p of pts) {
        const k = cellKey(p[0], p[1]);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(p);
      }
      this.poi.set(kind, grid);
    }
    for (const [service, spots] of Object.entries(file.repeatSpots)) {
      const m = new Map<string, number>();
      for (const [la, ln, n] of spots) m.set(`${Math.round(la / 0.0009)},${Math.round(ln / 0.0014)}`, n);
      this.repeat.set(service, m);
    }
    this.slope = Uint8Array.from(atob(file.slope.b64), (c) => c.charCodeAt(0));
    // Per type: the median community's requests per 1,000 residents (communities with people only).
    const rates = new Map<string, number[]>();
    for (const [comm, byType] of Object.entries(file.communityRequests)) {
      const pop = file.population[comm];
      if (!pop || pop < 500) continue;
      for (const [service, n] of Object.entries(byType)) {
        let arr = rates.get(service);
        if (!arr) rates.set(service, (arr = []));
        arr.push((n / pop) * 1000);
      }
    }
    rates.forEach((arr, service) => { arr.sort((a, b) => a - b); this.rateMedian.set(service, arr[Math.floor(arr.length / 2)]); });
  }

  /** A community's facts, and the city's middle values to compare against. */
  community(name: string): CommunityStats | null {
    return this.file.communities?.[name] ?? null;
  }
  get communityMedians(): { crossingsPerKm2: number; density: number } {
    if (this.medians) return this.medians;
    const v = Object.values(this.file.communities ?? {}).filter((c) => c.population >= 500);
    const med = (k: "crossingsPerKm2" | "density") => { const a = v.map((c) => c[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
    return (this.medians = { crossingsPerKm2: med("crossingsPerKm2"), density: med("density") });
  }
  private medians: { crossingsPerKm2: number; density: number } | null = null;

  /** Nearest point of a kind within its radius (metres), or undefined. */
  nearest(kind: PoiKind, la: number, ln: number): number | undefined {
    const grid = this.poi.get(kind);
    if (!grid) return undefined;
    const r = RADIUS[kind] / 1000;
    let best = Infinity;
    const cy = Math.floor(la / CELL), cx = Math.floor(ln / CELL);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      for (const p of grid.get((cy + dy) * 1000003 + cx + dx) ?? []) {
        const km = haversineKm(la, ln, p[0], p[1]);
        if (km < best) best = km;
      }
    }
    return best <= r ? Math.round(best * 1000) : undefined;
  }

  slopeAt(la: number, ln: number): number | null {
    const s = this.file.slope, w = project(la, ln);
    const i = Math.floor((w.x - s.minX) / s.cellKm), j = Math.floor((w.z - s.minZ) / s.cellKm);
    if (i < 0 || j < 0 || i >= s.w || j >= s.h) return null;
    return this.slope[j * s.w + i] / s.scale;
  }

  private cache = new Map<string, Site>();

  /** Site facts computed elsewhere (the data server attaches them to the live queue). */
  prime(id: string, site: Site) {
    this.cache.set(`${id}|1`, site);
    this.cache.set(`${id}|0`, site);
  }

  /** Facts about a ticket's spot (cached: a ticket's place doesn't change between plans). */
  site(t: { id?: string; service: string; community: string; lat: number; lng: number }, roadAt?: RoadAt | null): Site {
    const key = t.id ? `${t.id}|${roadAt ? 1 : 0}` : "";
    const hit = key ? this.cache.get(key) : undefined;
    if (hit) return hit;
    const s = this.compute(t, roadAt);
    if (key) this.cache.set(key, s);
    return s;
  }

  private compute(t: { service: string; community: string; lat: number; lng: number }, roadAt?: RoadAt | null): Site {
    const near: Site["near"] = {};
    for (const kind of Object.keys(RADIUS) as PoiKind[]) {
      const m = this.nearest(kind, t.lat, t.lng);
      if (m !== undefined) near[kind] = m;
    }
    const pop = this.file.population[t.community];
    const n = this.file.communityRequests[t.community]?.[t.service];
    const road = roadAt?.(t.lat, t.lng);
    return {
      road: road && road.metres < 80 ? road.cls : road ? null : null,
      near,
      slopePct: this.slopeAt(t.lat, t.lng),
      repeats: this.repeat.get(t.service)?.get(`${Math.round(t.lat / 0.0009)},${Math.round(t.lng / 0.0014)}`) ?? 0,
      areaRate: pop && pop >= 500 && n ? (n / pop) * 1000 : null,
      areaRateMedian: this.rateMedian.get(t.service) ?? null,
      closeP90: this.file.closeTargets[t.service]?.p90 ?? null,
    };
  }
}
