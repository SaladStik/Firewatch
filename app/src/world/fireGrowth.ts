/**
 * Fire growth over the real fuel map (runs in the worker, which has the land cover and terrain).
 *
 * Method: minimum travel time on a hex grid (the approach behind FlamMap's MTT, Finney 2002;
 * Canada's Prometheus uses the same FBP inputs with wavelet propagation). Each day, fire moves
 * from every burning hex to its neighbours. The time to cross into a neighbour is
 * distance ÷ rate of spread in that direction, where the rate comes from the FBP System
 * (data/cffdrs.ts) for the NEIGHBOUR's fuel type and that day's FWI values:
 *   - head rate downwind, back rate upwind, flanks in between (FBP elliptical fire shape),
 *     so a calm day still spreads in every direction through burnable fuel;
 *   - non-fuel (water, rock, ice) is never crossed;
 *   - upslope runs faster (FBP slope factor, ST-X-3 eq. 39).
 * Whatever is reached within the day's active burning time burns that day; the next day starts
 * from the new edge with the next day's weather. Each fire's own growth calibration `k`
 * (data/fireHistory.ts) and demo factors (heatwave, rainstorm) scale its rates.
 */
import { ACTIVE_BURN_MIN, fbpSpread, type FuelType } from "../data/cffdrs";
import { LandClass } from "../geo/landClass";
import { hexToWorld, NEIGHBORS, SQRT3, worldToHex } from "../hex/hexMath";

/** FBP fuel type per land class; null = doesn't burn (a fire break). */
export const FUEL_FOR_LAND: Partial<Record<LandClass, FuelType>> = {
  [LandClass.Forest]: "M-1", // boreal mixedwood (50 % conifer) as the general forest type
  [LandClass.Shrub]: "D-1", // deciduous / regenerating shrub
  [LandClass.Grass]: "O-1b", // standing grass
  [LandClass.Crop]: "O-1a", // matted grass / stubble
  [LandClass.Wetland]: "O-1a",
  [LandClass.Tundra]: "O-1a",
  [LandClass.Urban]: "D-1", // wildland-urban interface: fire can enter towns, slower than forest
};
/** Rate multiplier for urban hexes on top of D-1 (yards, streets and lawns interrupt spread). */
const URBAN_FACTOR = 0.5;

export interface GrowthDay {
  ffmc: number;
  isi: number;
  bui: number;
  wind: number; // km/h
  windFrom: number; // degrees
  curing: number; // grass curing %
  /** Extra rate multiplier for the day (demo heatwave × demo rainstorm). */
  factor: number;
}

export interface GrowthSource {
  x: number;
  z: number;
  /** Current fire radius (km): everything inside is already burning. */
  r0: number;
  /** Growth calibration from the fire's own history. */
  k: number;
  /** Weather at the fire for days 0..horizon. */
  days: GrowthDay[];
}

/** Projected burn: hex cells (axial q, r) at `size` km, each with the forecast day it burns. */
export interface GrowthField {
  size: number;
  /** Flat [q, r, day, q, r, day, …]. */
  cells: number[];
}

/** Most cells simulated per fire (keeps a runaway projection bounded). */
const MAX_CELLS_PER_FIRE = 60_000;

type Land = (x: number, z: number) => LandClass;
type Elev = (x: number, z: number) => number;

/** Pick one grid size for all fires so their projections share a grid (≈ 70 cells per fastest reach). */
export function growthCellSize(sources: GrowthSource[], horizon: number): number {
  let reach = 0;
  for (const s of sources) {
    let r = s.r0;
    for (let d = 0; d <= horizon && d < s.days.length; d++) {
      const w = s.days[d];
      r += (fbpSpread("O-1b", w, w.curing).ros * ACTIVE_BURN_MIN * s.k * w.factor) / 1000;
    }
    reach = Math.max(reach, r);
  }
  return Math.min(3, Math.max(0.3, reach / 70));
}

const key = (q: number, r: number) => (q + 50_000) * 100_003 + (r + 50_000);

/** Distance (along direction θ from the head) to the edge of the FBP fire ellipse, per unit time. */
export function rateAtAngle(ros: number, bros: number, lb: number, cosT: number): number {
  const a = (ros + bros) / 2, b = a / lb, c = a - bros;
  const sin2 = 1 - cosT * cosT;
  const A = (cosT * cosT) / (a * a) + sin2 / (b * b), B = (-2 * c * cosT) / (a * a), C = (c * c) / (a * a) - 1;
  return (-B + Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
}

/** FBP slope factor for an upslope run (ST-X-3 eq. 39), capped at 60 % slope. */
const slopeFactor = (pct: number) => (pct <= 0 ? 1 : Math.exp(3.533 * (Math.min(60, pct) / 100) ** 1.2));

export function simulateGrowth(sources: GrowthSource[], horizon: number, size: number, land: Land, elev: Elev): GrowthField {
  const out: number[] = [];
  const stepKm = size * SQRT3; // centre-to-centre distance between neighbouring hexes
  for (const src of sources) {
    const burned = new Map<number, number>(); // key → day burned (-1 = already burning)
    const fuelCache = new Map<number, FuelType | null>();
    const urban = new Set<number>();
    const fuelOf = (q: number, r: number) => {
      const k = key(q, r);
      let f = fuelCache.get(k);
      if (f === undefined) {
        const w = hexToWorld(q, r, size), lc = land(w.x, w.z);
        f = FUEL_FOR_LAND[lc] ?? null;
        if (lc === LandClass.Urban) urban.add(k);
        fuelCache.set(k, f);
      }
      return f;
    };
    // Ignition: every hex inside the current fire.
    const c = worldToHex(src.x, src.z, size), rr = Math.ceil(src.r0 / stepKm) + 1;
    for (let dq = -rr; dq <= rr; dq++) for (let dr = -rr; dr <= rr; dr++) {
      const q = c.q + dq, r = c.r + dr, w = hexToWorld(q, r, size);
      if (Math.hypot(w.x - src.x, w.z - src.z) <= Math.max(src.r0, size)) burned.set(key(q, r), -1);
    }
    const qr = new Map<number, [number, number]>();
    for (const k of burned.keys()) qr.set(k, [Math.floor(k / 100_003) - 50_000, (k % 100_003) - 50_000]);

    for (let d = 0; d <= horizon && d < src.days.length; d++) {
      const W = src.days[d];
      const rate = src.k * W.factor;
      if (rate <= 0) continue;
      // Head direction (downwind) in world XZ (+X east, +Z south).
      const a = (W.windFrom * Math.PI) / 180;
      const hx = Number.isFinite(a) ? -Math.sin(a) : 0, hz = Number.isFinite(a) ? Math.cos(a) : 1;
      const perFuel = new Map<FuelType, { ros: number; bros: number; lb: number }>();
      const spreadFor = (f: FuelType) => {
        let s = perFuel.get(f);
        if (!s) { const v = fbpSpread(f, W, W.curing); s = { ros: v.ros * rate, bros: v.bros * rate, lb: v.lb }; perFuel.set(f, s); }
        return s;
      };
      // Dijkstra from the burning edge, bounded by the day's active burning minutes.
      const time = new Map<number, number>();
      const heap = new MinHeap();
      for (const [k] of burned) { time.set(k, 0); heap.push(0, k); }
      const reached: number[] = [];
      while (heap.size) {
        const [t, k] = heap.pop();
        if (t > (time.get(k) ?? Infinity)) continue;
        if (!burned.has(k)) reached.push(k);
        const [q, r] = qr.get(k)!;
        const p = hexToWorld(q, r, size), e0 = elev(p.x, p.z);
        for (const n of NEIGHBORS) {
          const nq = q + n.q, nr = n.r + r, nk = key(nq, nr);
          if (burned.has(nk)) continue;
          const f = fuelOf(nq, nr);
          if (!f) continue;
          const np = hexToWorld(nq, nr, size);
          const cosT = ((np.x - p.x) * hx + (np.z - p.z) * hz) / stepKm;
          const s = spreadFor(f);
          let v = rateAtAngle(s.ros, s.bros, s.lb, cosT) * (urban.has(nk) ? URBAN_FACTOR : 1); // m/min
          const slope = ((elev(np.x, np.z) - e0) / (stepKm * 1000)) * 100;
          v *= slopeFactor(slope);
          if (v <= 1e-6) continue;
          const nt = t + (stepKm * 1000) / v;
          if (nt > ACTIVE_BURN_MIN || nt >= (time.get(nk) ?? Infinity)) continue;
          time.set(nk, nt);
          qr.set(nk, [nq, nr]);
          heap.push(nt, nk);
        }
      }
      for (const k of reached) burned.set(k, d);
      if (burned.size > MAX_CELLS_PER_FIRE) break;
    }
    for (const [k, day] of burned) if (day >= 0) { const [q, r] = qr.get(k)!; out.push(q, r, day); }
  }
  return { size, cells: out };
}

/** Lookup: forecast day a world point is projected to burn, or -1. */
export function growthLookup(field: GrowthField | null | undefined): (x: number, z: number) => number {
  if (!field?.cells.length) return () => -1;
  const m = new Map<number, number>();
  for (let i = 0; i < field.cells.length; i += 3) {
    const k = key(field.cells[i], field.cells[i + 1]);
    m.set(k, Math.min(m.get(k) ?? Infinity, field.cells[i + 2]));
  }
  return (x, z) => {
    const h = worldToHex(x, z, field.size);
    return m.get(key(h.q, h.r)) ?? -1;
  };
}

/** Small binary min-heap of (time, key). */
class MinHeap {
  private t: number[] = [];
  private k: number[] = [];
  get size() { return this.t.length; }
  push(t: number, k: number) {
    const a = this.t, b = this.k;
    let i = a.length;
    a.push(t); b.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]]; [b[p], b[i]] = [b[i], b[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.t, b = this.k;
    const top: [number, number] = [a[0], b[0]];
    const lt = a.pop()!, lk = b.pop()!;
    if (a.length) {
      a[0] = lt; b[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [b[m], b[i]] = [b[i], b[m]];
        i = m;
      }
    }
    return top;
  }
}
