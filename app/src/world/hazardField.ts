/**
 * Turns a HazardSnapshot into a per-hex { status, risk } (pure — runs in the worker).
 *
 * Risk model (transparent + tweakable, NOT an official index):
 *   risk = weatherRisk(lat,lng) × fuel(landType) + proximity boost near hotspots
 * Direct observations override: inside an active perimeter / near a hotspot.
 */
import { unproject } from "../geo/projection";
import { NODE_TYPES, NodeStatus, statusForRisk } from "../hex/nodeTypes";
import type { LandClass } from "../geo/landClass";
import type { HazardSnapshot } from "./types";

const BUCKET_KM = 40;
/** Hotspots raise risk within this radius (spread potential). */
export const HOTSPOT_INFLUENCE_KM = 30;

export class HazardField {
  private buckets = new Map<string, HazardSnapshot["hotspots"]>();
  constructor(private snap: HazardSnapshot) {
    for (const h of snap.hotspots) {
      const k = `${Math.floor(h.x / BUCKET_KM)},${Math.floor(h.z / BUCKET_KM)}`;
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push(h);
    }
  }

  /** Nearest hotspot distance (km) within `maxKm`, else Infinity. */
  nearestHotspot(x: number, z: number, maxKm: number): number {
    let best = Infinity;
    const r = Math.ceil(maxKm / BUCKET_KM);
    const bx = Math.floor(x / BUCKET_KM), bz = Math.floor(z / BUCKET_KM);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const b = this.buckets.get(`${bx + dx},${bz + dz}`);
      if (b) for (const h of b) best = Math.min(best, Math.hypot(h.x - x, h.z - z));
    }
    return best <= maxKm ? best : Infinity;
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

  evaluate(x: number, z: number, land: LandClass, hexSize: number): { status: NodeStatus; risk: number } {
    const fuel = NODE_TYPES[land]?.fuel ?? 0;
    const d = this.nearestHotspot(x, z, HOTSPOT_INFLUENCE_KM);
    // A hotspot pixel is ~375 m; count it if it falls inside this hex.
    if (d <= Math.max(hexSize * 0.95, 0.4)) return { status: NodeStatus.Burning, risk: 1 };
    const perim = this.inPerimeter(x, z);
    if (perim === 2) return { status: NodeStatus.Perimeter, risk: 0.95 };
    let risk = this.weatherRisk(x, z) * fuel;
    if (d < Infinity) risk += 0.55 * (1 - d / HOTSPOT_INFLUENCE_KM) * Math.max(0.3, fuel);
    risk = Math.min(1, risk);
    if (perim === 1) return { status: NodeStatus.Burned, risk: risk * 0.3 };
    return { status: fuel === 0 ? NodeStatus.Normal : statusForRisk(risk), risk };
  }
}
