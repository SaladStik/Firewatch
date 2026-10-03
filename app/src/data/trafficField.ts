/**
 * The state of the highway network on one day, point by point: how many vehicles a stretch
 * carries, how jammed that makes it, and whether fire has closed it.
 *
 * Built in the same pass that ranks the corridors (data/trafficRisk.ts), so the list in the
 * forecast bar and the vehicles on the map can never disagree. Sampled by
 * render/TrafficParticles.ts, in the same way RainField feeds RainParticles.
 *
 * Every region's points are flattened into one set of arrays, with a route table over them,
 * because what drives along a route doesn't care which province it came from. The points are
 * not evenly spaced — the bake spends them where the road curves — so each route is measured
 * on construction and `sample` looks positions up by distance travelled.
 */
import type { TrafficNetwork } from "./traffic";

/** One continuous run of road, as a slice of the field's arrays. */
export interface TrafficRoute {
  /** First point of the route, and how many it has. */
  start: number;
  count: number;
  /** Length of the route (km). */
  km: number;
  /** Bounding box in world km, for deciding what's in view without walking the points. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Length-weighted mean vehicles a day along it, used to weight where vehicles spawn. */
  volume: number;
  /** Highway number. */
  n: string;
  /** Workspace index of the region it belongs to. */
  region: number;
}

export class TrafficField {
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Distance from its own route's start to each point (km). */
  readonly along: Float32Array;
  /** Vehicles a day at each point, including anything the scenario adds. */
  readonly volume: Float32Array;
  /** 0 = free-flowing, 1 = gridlock (data/traffic.ts jamLevel). */
  readonly jam: Float32Array;
  /** 1 where the scenario has fire across the road. */
  readonly closed: Uint8Array;
  readonly routes: TrafficRoute[] = [];
  /** Longest gap between consecutive points, which bounds a lookahead along the road (km). */
  readonly maxGapKm: number;
  /** True when a demo scenario is applied, so the UI can flag it. */
  readonly simulated: boolean;

  constructor(networks: TrafficNetwork[], simulated: boolean) {
    this.simulated = simulated;
    this.maxGapKm = networks[0]?.maxGapKm ?? 2;
    const total = networks.reduce((n, net) => n + net.hwy.length, 0);
    this.x = new Float32Array(total);
    this.z = new Float32Array(total);
    this.along = new Float32Array(total);
    this.volume = new Float32Array(total);
    this.jam = new Float32Array(total);
    this.closed = new Uint8Array(total);
    // Copy the geometry in, measure each route and build the route table; the per-point
    // values are filled by whoever is scoring the day (trafficRisk.ts).
    let n = 0;
    for (const net of networks) {
      this.x.set(net.x, n);
      this.z.set(net.z, n);
      for (let r = 0; r < net.routeStart.length; r++) {
        const count = net.routeCount[r];
        if (count < 2) continue;
        const start = n + net.routeStart[r];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, km = 0;
        for (let i = start; i < start + count; i++) {
          if (i > start) km += Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
          this.along[i] = km;
          minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i]);
          minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i]);
        }
        this.routes.push({
          start, count, km, minX, maxX, minZ, maxZ, volume: 0,
          n: net.highways[net.hwy[net.routeStart[r]]]?.n ?? "",
          region: net.region,
        });
      }
      n += net.hwy.length;
    }
  }

  /** Length-weighted mean volume per route, once the per-point volumes are in. */
  summarise() {
    for (const r of this.routes) {
      if (r.km <= 0) continue;
      let sum = 0;
      for (let i = r.start + 1; i < r.start + r.count; i++) {
        // Each segment is credited the mean of its two ends.
        sum += ((this.volume[i] + this.volume[i - 1]) / 2) * (this.along[i] - this.along[i - 1]);
      }
      r.volume = sum / r.km;
    }
  }

  /** The point index at or before `s` km along a route (binary search over `along`). */
  private indexAt(route: TrafficRoute, s: number): number {
    let lo = route.start, hi = route.start + route.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.along[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return Math.min(lo, route.start + route.count - 2);
  }

  /** Position and state partway along a route, `s` km from its start. */
  sample(route: TrafficRoute, s: number): { x: number; z: number; jam: number; closed: boolean; volume: number } {
    const clamped = Math.min(Math.max(s, 0), route.km);
    const i = this.indexAt(route, clamped);
    const span = this.along[i + 1] - this.along[i];
    const t = span > 0 ? (clamped - this.along[i]) / span : 0;
    // State is taken from the point just behind, not blended: a closed stretch has an edge.
    return {
      x: this.x[i] + (this.x[i + 1] - this.x[i]) * t,
      z: this.z[i] + (this.z[i + 1] - this.z[i]) * t,
      jam: this.jam[i],
      closed: this.closed[i] === 1,
      volume: this.volume[i],
    };
  }

  /** Length of a route (km). */
  length(route: TrafficRoute): number {
    return route.km;
  }
}
