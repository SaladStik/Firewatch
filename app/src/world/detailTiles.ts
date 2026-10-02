/**
 * Detail lines (tertiary / local roads, forest tracks, streams) for one region,
 * fetched lazily as 1° tiles (public/data/<region>/lines/<lat>_<lng>.json) the
 * first time a street-zoom chunk needs them. Pure — runs in the worker.
 *
 * Tile format: { o: [lat0, lng0], l: [[id, kind, x0, y0, dx1, dy1, …], …] }
 * coordinates in 1e-5 deg (~1 m): first point relative to the tile origin, then deltas.
 */
import type { LineKind } from "../geo/lineKinds";
import { project, unproject } from "../geo/projection";
import { LINE_STYLES } from "../hex/overlayStyles";

const CELL = 2; // km, segment bucket size
const key = (bx: number, bz: number) => bx * 100003 + bz;

interface Seg { x1: number; z1: number; x2: number; z2: number; kind: LineKind; widthKm: number }

export class DetailTiles {
  private available: Set<string> | null = null;
  private q = 1e5;
  private loaded = new Map<string, Promise<void>>();
  private buckets = new Map<number, Seg[]>();
  private seenLines = new Set<number>();

  constructor(private url: string) {}

  /** Read the tile index once (regions without detail tiles simply have none). */
  async init() {
    try {
      const r = await fetch(`${this.url}/lines/index.json`);
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { q: number; tiles: string[] };
      this.q = j.q;
      this.available = new Set(j.tiles);
    } catch {
      this.available = new Set();
    }
  }

  /** Make sure every tile overlapping these world bounds is loaded. */
  async ensure(b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    if (!this.available?.size) return;
    // World bounds → lat/lng range (sample the corners and edge midpoints; LCC is curved).
    let la0 = 90, la1 = -90, ln0 = 180, ln1 = -180;
    for (const x of [b.minX, (b.minX + b.maxX) / 2, b.maxX]) {
      for (const z of [b.minZ, (b.minZ + b.maxZ) / 2, b.maxZ]) {
        const { lat, lng } = unproject(x, z);
        la0 = Math.min(la0, lat); la1 = Math.max(la1, lat); ln0 = Math.min(ln0, lng); ln1 = Math.max(ln1, lng);
      }
    }
    const jobs: Promise<void>[] = [];
    for (let lat = Math.floor(la0); lat <= Math.floor(la1); lat++) {
      for (let lng = Math.floor(ln0); lng <= Math.floor(ln1); lng++) {
        const name = `${lat}_${lng}`;
        if (!this.available.has(name)) continue;
        let p = this.loaded.get(name);
        if (!p) { p = this.load(name); this.loaded.set(name, p); }
        jobs.push(p);
      }
    }
    await Promise.all(jobs);
  }

  private async load(name: string) {
    let j: { o: [number, number]; l: number[][] };
    try {
      j = await (await fetch(`${this.url}/lines/${name}.json`)).json();
    } catch {
      return;
    }
    const [lat0, lng0] = j.o, q = this.q;
    for (const line of j.l) {
      const id = line[0];
      if (this.seenLines.has(id)) continue; // lines crossing tiles are stored in each
      this.seenLines.add(id);
      const kind = line[1] as LineKind;
      const widthKm = LINE_STYLES[kind]?.widthKm ?? 0.01;
      let qx = 0, qy = 0;
      let prev: { x: number; z: number } | null = null;
      for (let i = 2; i < line.length; i += 2) {
        qx += line[i]; qy += line[i + 1];
        const p = project(lat0 + qy / q, lng0 + qx / q);
        if (prev) this.add({ x1: prev.x, z1: prev.z, x2: p.x, z2: p.z, kind, widthKm });
        prev = p;
      }
    }
  }

  private add(s: Seg) {
    // Register in every bucket the segment passes through.
    const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
    let last = NaN;
    for (let t = 0; t <= steps; t++) {
      const k = key(Math.floor((s.x1 + ((s.x2 - s.x1) * t) / steps) / CELL), Math.floor((s.z1 + ((s.z2 - s.z1) * t) / steps) / CELL));
      if (k === last) continue;
      last = k;
      let arr = this.buckets.get(k);
      if (!arr) this.buckets.set(k, (arr = []));
      arr.push(s);
    }
  }

  *segments(b: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    const seen = new Set<Seg>();
    for (let bz = Math.floor(b.minZ / CELL); bz <= Math.floor(b.maxZ / CELL); bz++) {
      for (let bx = Math.floor(b.minX / CELL); bx <= Math.floor(b.maxX / CELL); bx++) {
        for (const s of this.buckets.get(key(bx, bz)) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          yield s;
        }
      }
    }
  }
}
