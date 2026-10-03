/**
 * Turns a HazardSnapshot into a per-hex { status, risk } (pure — runs in the worker).
 *
 * Risk model (transparent + tweakable, NOT the Canadian FWI):
 *   risk = weatherRisk(lat,lng) × fuel(landType) + wind-shaped boost near hotspots
 * weatherRisk = Fosberg FFWI / 100 × days-since-rain dryness × the day's rain damping.
 * Demo rainstorms damp the whole score under them (data/rain.ts).
 * Direct observations override: an agency-reported fire (out of control / being held / under
 * control) / inside an active perimeter. Hotspots are unconfirmed heat detections: they add the
 * boost but never give a hex a fire status.
 */
import { growthLookup } from "./fireGrowth";
import { blobDamping, blobRain } from "../data/rain";
import { unproject } from "../geo/projection";
import { NODE_TYPES, NodeStatus, statusForRisk } from "../hex/nodeTypes";
import type { LandClass } from "../geo/landClass";
import { SPREAD_MAX_KM, spreadInfluence } from "./spread";
import type { HazardSnapshot } from "./types";

const BUCKET_KM = 40;
/** Numeric bucket key (this runs for every hex on every restatus; string keys were the hot spot). */
const bucketKey = (bx: number, bz: number) => bx * 100003 + bz;

export class HazardField {
  private buckets = new Map<number, HazardSnapshot["hotspots"]>();
  constructor(private snap: HazardSnapshot) {
    this.spreadDay = growthLookup(snap.spread);
    for (const h of snap.hotspots) {
      const k = bucketKey(Math.floor(h.x / BUCKET_KM), Math.floor(h.z / BUCKET_KM));
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push(h);
    }
  }

  private forHotspotsNear(x: number, z: number, maxKm: number, fn: (h: HazardSnapshot["hotspots"][number]) => void) {
    const r = Math.ceil(maxKm / BUCKET_KM);
    const bx = Math.floor(x / BUCKET_KM), bz = Math.floor(z / BUCKET_KM);
    if (!this.buckets.size) return;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const b = this.buckets.get(bucketKey(bx + dx, bz + dz));
      if (b) for (const h of b) fn(h);
    }
  }

  /** Nearest hotspot distance (km) within `maxKm`, else Infinity. */
  nearestHotspot(x: number, z: number, maxKm: number): number {
    let best = Infinity;
    this.forHotspotsNear(x, z, maxKm, (h) => { best = Math.min(best, Math.hypot(h.x - x, h.z - z)); });
    return best <= maxKm ? best : Infinity;
  }

  /** Strongest wind-shaped hotspot influence at a point, 0..1. */
  spreadAt(x: number, z: number): number {
    let best = 0;
    this.forHotspotsNear(x, z, SPREAD_MAX_KM, (h) => { best = Math.max(best, spreadInfluence(x - h.x, z - h.z, h)); });
    return best;
  }

  weatherRisk(x: number, z: number): number {
    const { lat, lng } = unproject(x, z);
    const w = this.snap.weather.find((g) => lat >= g.lat0 && lat <= g.lat0 + (g.nLat - 1) * g.step && lng >= g.lng0 && lng <= g.lng0 + (g.nLng - 1) * g.step);
    if (!w) return 0.2;
    const fi = Math.min(w.nLng - 1.001, Math.max(0, (lng - w.lng0) / w.step));
    const fj = Math.min(w.nLat - 1.001, Math.max(0, (lat - w.lat0) / w.step));
    const i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, tz = fj - j;
    const g = (a: number, b: number) => w.risk[b * w.nLng + a];
    return (g(i, j) * (1 - tx) + g(i + 1, j) * tx) * (1 - tz) + (g(i, j + 1) * (1 - tx) + g(i + 1, j + 1) * tx) * tz;
  }

  private inPerimeter(x: number, z: number): 0 | 1 | 2 {
    for (const p of this.snap.perimeters) {
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      let inside = false;
      for (const ring of p.rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const zi = ring[i + 1], zj = ring[j + 1];
          if ((zi > z) !== (zj > z) && x < ((ring[j] - ring[i]) * (z - zi)) / (zj - zi) + ring[i]) inside = !inside;
        }
      }
      if (inside) return p.active ? 2 : 1;
    }
    return 0;
  }

  /**
   * Projected to burn by the selected day (fuel-aware growth model)? A map hex counts if ANY part
   * of it is reached (centre + 6 points toward its corners), so a small projection still shows
   * on coarse hexes instead of slipping between their centres.
   */
  private spreadDay = growthLookup(null);
  private inSpread(x: number, z: number, hexSize: number): boolean {
    if (!this.snap.spread?.cells.length) return false;
    if (this.spreadDay(x, z) >= 0) return true;
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      if (this.spreadDay(x + Math.cos(a) * hexSize * 0.75, z + Math.sin(a) * hexSize * 0.75) >= 0) return true;
    }
    return false;
  }

  evaluate(x: number, z: number, land: LandClass, hexSize: number): { status: NodeStatus; risk: number } {
    const fuel = NODE_TYPES[land]?.fuel ?? 0;
    // A reported fire whose area (or point, if small) touches this hex; the worst stage wins.
    const reach = Math.max(hexSize * 0.95, 0.4);
    let stage = 3;
    for (const f of this.snap.reported) if (f.stage < stage && Math.hypot(f.x - x, f.z - z) <= f.r + reach) stage = f.stage;
    if (stage === 0) return { status: NodeStatus.Burning, risk: 1 };
    if (stage === 1) return { status: NodeStatus.Perimeter, risk: 0.95 };
    if (stage === 2) return { status: NodeStatus.UnderControl, risk: 0.6 };
    const perim = this.inPerimeter(x, z);
    if (perim === 2) return { status: NodeStatus.Perimeter, risk: 0.95 };
    let risk = this.weatherRisk(x, z) * fuel;
    const spread = this.spreadAt(x, z);
    if (spread > 0) risk += 0.55 * spread * Math.max(0.3, fuel);
    // Rain under a demo storm wets everything, fire-adjacent hexes included.
    if (this.snap.rain.length) risk *= blobDamping(blobRain(this.snap.rain, x, z));
    risk = Math.min(1, risk);
    // Projected spread only marks burnable ground outside existing burn scars.
    if (perim === 0 && fuel > 0 && this.inSpread(x, z, hexSize)) return { status: NodeStatus.Projected, risk };
    if (perim === 1) return { status: NodeStatus.Burned, risk: risk * 0.3 };
    return { status: fuel === 0 ? NodeStatus.Normal : statusForRisk(risk), risk };
  }
}
