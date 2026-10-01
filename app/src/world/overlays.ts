/**
 * Vector overlays (OSM rivers/roads/rail + buildings + landmarks),
 * spatially indexed once and cut per chunk so they stream with the hexes.
 * Lines keep their real geometry; each grid level gets a simplification matched to its hex size.
 * Pure — runs inside the worker.
 */
import { LineKind } from "../geo/lineKinds";
import { project } from "../geo/projection";
import { BUILDING_KINDS, lineWidthKm, showsAsNodes, TOWER_MIN_HEIGHT, type BuildingKind, type Landmark } from "../hex/overlayStyles";

export interface OsmData {
  buildings: [number, number, number, number, number][]; // lat, lng, heightM, wKm, dKm
  lines: { k: LineKind; w?: number; p: number[] }[];
}

/** Floats per building: x, z, wKm, dKm, hKm, kindIndex, hexIndex. */
export const BLD_STRIDE = 7;

const CELL = 5; // km, bucket size
const key = (bx: number, bz: number) => bx * 100003 + bz;

/** One grid level's line segments (simplified for that level's hex size), bucketed spatially. */
interface LevelSegments {
  x1: Float32Array; z1: Float32Array; x2: Float32Array; z2: Float32Array;
  kind: Uint8Array; width: Float32Array;
  buckets: Map<number, number[]>;
}

/** Douglas–Peucker on projected km coordinates. */
function simplify(xs: Float32Array, zs: Float32Array, tol: number): number[] {
  const n = xs.length;
  if (n < 3) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const dx = xs[b] - xs[a], dz = zs[b] - zs[a], len = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((xs[i] - xs[a]) * dz - (zs[i] - zs[a]) * dx) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export class OverlayIndex {
  private lines: { k: LineKind; w: number; xs: Float32Array; zs: Float32Array }[] = [];
  private levels = new Map<number, LevelSegments>();
  // buildings
  private b: Float32Array; // x, z, w, d, hKm, kind, isLandmark
  private bldBuckets = new Map<number, number[]>();

  constructor(osm: OsmData | null, landmarks: Landmark[]) {
    for (const l of osm?.lines ?? []) {
      const n = l.p.length / 2;
      const xs = new Float32Array(n), zs = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w = project(l.p[i * 2 + 1], l.p[i * 2]);
        xs[i] = w.x; zs[i] = w.z;
      }
      this.lines.push({ k: l.k, w: l.w ?? 0, xs, zs });
    }

    // Buildings: landmarks replace any OSM building within 120 m of them.
    const lm = landmarks.map((l) => ({ ...l, ...project(l.lat, l.lng) }));
    // Row: x, z, w, d, hKm, kind, isLandmark
    const rows: number[] = [];
    for (const [lat, lng, h, w, d] of osm?.buildings ?? []) {
      const p = project(lat, lng);
      if (lm.some((l) => Math.hypot(l.x - p.x, l.z - p.z) < 0.12)) continue;
      rows.push(p.x, p.z, Math.max(0.02, w), Math.max(0.02, d), h / 1000, kindIndex(h >= TOWER_MIN_HEIGHT ? "tower" : "block"), 0);
    }
    for (const l of lm) rows.push(l.x, l.z, l.sizeKm, l.sizeKm, l.heightM / 1000, kindIndex(l.kind), 1);
    this.b = Float32Array.from(rows);
    for (let i = 0; i < rows.length / 7; i++) this.bucket(this.bldBuckets, this.b[i * 7], this.b[i * 7 + 1], i);
  }

  /**
   * Segments for one grid level (built once, lazily): only the line kinds that level shows,
   * simplified to a tolerance that matches its hex size so detail scales with zoom.
   */
  private level(level: number, tolKm: number, hexSize: number, finest: boolean): LevelSegments {
    let L = this.levels.get(level);
    if (L) return L;
    const x1: number[] = [], z1: number[] = [], x2: number[] = [], z2: number[] = [], kind: number[] = [], width: number[] = [];
    const buckets = new Map<number, number[]>();
    for (const line of this.lines) {
      if (!showsAsNodes(lineWidthKm(line.k, line.w), hexSize, finest)) continue;
      const idx = simplify(line.xs, line.zs, tolKm);
      for (let j = 0; j + 1 < idx.length; j++) {
        const a = idx[j], b = idx[j + 1], si = kind.length;
        x1.push(line.xs[a]); z1.push(line.zs[a]); x2.push(line.xs[b]); z2.push(line.zs[b]);
        kind.push(line.k); width.push(lineWidthKm(line.k, line.w));
        // Register the segment in every bucket it passes through.
        const len = Math.hypot(line.xs[b] - line.xs[a], line.zs[b] - line.zs[a]);
        const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
        const seen = new Set<number>();
        for (let t = 0; t <= steps; t++) {
          const x = line.xs[a] + ((line.xs[b] - line.xs[a]) * t) / steps, z = line.zs[a] + ((line.zs[b] - line.zs[a]) * t) / steps;
          const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
          if (seen.has(k)) continue;
          seen.add(k);
          let arr = buckets.get(k);
          if (!arr) buckets.set(k, (arr = []));
          arr.push(si);
        }
      }
    }
    L = {
      x1: Float32Array.from(x1), z1: Float32Array.from(z1), x2: Float32Array.from(x2), z2: Float32Array.from(z2),
      kind: Uint8Array.from(kind), width: Float32Array.from(width), buckets,
    };
    this.levels.set(level, L);
    return L;
  }

  /** Real line segments near `bounds` at this level's simplification. */
  *segments(level: number, tolKm: number, hexSize: number, finest: boolean, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    const L = this.level(level, tolKm, hexSize, finest);
    const seen = new Set<number>();
    for (let bz = Math.floor(bounds.minZ / CELL); bz <= Math.floor(bounds.maxZ / CELL); bz++) {
      for (let bx = Math.floor(bounds.minX / CELL); bx <= Math.floor(bounds.maxX / CELL); bx++) {
        for (const i of L.buckets.get(key(bx, bz)) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          yield { x1: L.x1[i], z1: L.z1[i], x2: L.x2[i], z2: L.z2[i], kind: L.kind[i] as LineKind, widthKm: L.width[i] };
        }
      }
    }
  }

  private bucket(map: Map<number, number[]>, x: number, z: number, i: number) {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    arr.push(i);
  }

  private *candidates(map: Map<number, number[]>, b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    for (let bz = Math.floor(b.minZ / CELL); bz <= Math.floor(b.maxZ / CELL); bz++) {
      for (let bx = Math.floor(b.minX / CELL); bx <= Math.floor(b.maxX / CELL); bx++) {
        const arr = map.get(key(bx, bz));
        if (arr) yield* arr;
      }
    }
  }

  /** Buildings standing on hexes of this chunk (x, z, w, d, hKm, kind, hexIndex). */
  buildings(
    minHeightM: number,
    landmarks: boolean,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    owner: (x: number, z: number) => number,
  ): Float32Array {
    const out: number[] = [];
    for (const i of this.candidates(this.bldBuckets, bounds)) {
      const o = i * 7;
      const isLandmark = this.b[o + 6] === 1;
      if (isLandmark ? !landmarks : this.b[o + 4] * 1000 < minHeightM) continue;
      const hi = owner(this.b[o], this.b[o + 1]);
      if (hi < 0) continue;
      out.push(this.b[o], this.b[o + 1], this.b[o + 2], this.b[o + 3], this.b[o + 4], this.b[o + 5], hi);
    }
    return Float32Array.from(out);
  }
}

function kindIndex(k: BuildingKind) {
  return BUILDING_KINDS.indexOf(k);
}
