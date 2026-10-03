/**
 * Street router for 311 crews: the fastest drive between stops over the real road network.
 *
 * The network comes from the same OpenStreetMap line tiles the map draws (public/data/<region>/
 * lines/<lat>_<lng>.json): every highway, arterial, collector and local street, plus tracks.
 * Edges cost travel time at a typical city speed for the road class. Routing is A* with a
 * straight-line-at-top-speed heuristic. Limits: the bake keeps no one-way or turn restrictions and
 * no street names, so routes are drivable paths, not turn-by-turn directions.
 */
import { LineKind } from "../geo/lineKinds";
import { haversineKm } from "./csv";

/** Typical urban driving speed by road class (km/h). */
const SPEED: Partial<Record<number, number>> = {
  [LineKind.Highway]: 80,
  [LineKind.Bridge]: 50,
  [LineKind.Primary]: 60,
  [LineKind.Secondary]: 50,
  [LineKind.Tertiary]: 50,
  [LineKind.Local]: 35,
  [LineKind.Track]: 20,
};
const TOP_SPEED = 80;
/** Way ends within this distance of another road's point are joined (the bake can drop shared nodes). */
const JOIN_KM = 0.03;

interface Tile { o: [number, number]; l: number[][] }

export interface LatLng { lat: number; lng: number }

export interface Leg {
  /** Path from the previous stop (or the depot) to this one. */
  path: LatLng[];
  km: number;
  minutes: number;
  /** Share of the leg on arterials or highways (vs local streets). */
  mainRoadShare: number;
}

export class RoadGraph {
  lat: Float64Array;
  lng: Float64Array;
  /** Adjacency (CSR): edges of node i are adj[off[i] .. off[i+1]); cost in minutes, length in km. */
  private off: Int32Array;
  private to: Int32Array;
  private cost: Float32Array;
  private len: Float32Array;
  private main: Uint8Array;
  private grid = new Map<number, number[]>();
  /** Connected component of each node, and the largest one (the city's street network). */
  private comp!: Int32Array;
  private mainComp = 0;
  readonly nodes: number;
  readonly edges: number;

  /**
   * Build from line tiles, keeping roads inside `bbox` = [west, south, east, north].
   * The bake simplifies lines, so roads that cross often share no point: junctions are inserted
   * wherever two road segments cross, and dead ends within JOIN_KM of another road are snapped onto it.
   */
  constructor(tiles: Tile[], q: number, bbox: [number, number, number, number]) {
    const [W, S, E, N] = bbox;
    const kx = 111.32 * Math.cos((((S + N) / 2) * Math.PI) / 180), ky = 110.574; // km per degree
    const ids = new Map<string, number>(), lat: number[] = [], lng: number[] = [];
    const node = (la: number, ln: number) => {
      const k = `${Math.round(la * 1e5)},${Math.round(ln * 1e5)}`;
      let i = ids.get(k);
      if (i === undefined) { i = lat.length; ids.set(k, i); lat.push(la); lng.push(ln); }
      return i;
    };
    // 1. Road segments.
    interface Seg { a: number; b: number; way: number; speed: number; main: number; splits: { t: number; n: number }[] }
    const segs: Seg[] = [];
    const ends: number[] = [];
    const seen = new Set<number>();
    for (const t of tiles) {
      const [lat0, lng0] = t.o;
      for (const line of t.l) {
        const speed = SPEED[line[1]];
        if (!speed || seen.has(line[0])) continue;
        seen.add(line[0]);
        const main = line[1] === LineKind.Highway || line[1] === LineKind.Primary || line[1] === LineKind.Secondary || line[1] === LineKind.Bridge ? 1 : 0;
        let qx = 0, qy = 0, prev = -1;
        for (let i = 2; i < line.length; i += 2) {
          qx += line[i]; qy += line[i + 1];
          const la = lat0 + qy / q, ln = lng0 + qx / q;
          if (la < S || la > N || ln < W || ln > E) { prev = -1; continue; }
          const cur = node(la, ln);
          if (prev >= 0 && prev !== cur) segs.push({ a: prev, b: cur, way: line[0], speed, main, splits: [] });
          if (prev < 0 || i + 2 >= line.length) ends.push(cur);
          prev = cur;
        }
      }
    }
    const X = (i: number) => lng[i] * kx, Y = (i: number) => lat[i] * ky;
    // 2. Bucket segments by grid cell (~300 m).
    const CELL = 0.3;
    const cells = new Map<number, number[]>();
    const ck = (cx: number, cy: number) => cx * 100003 + cy;
    segs.forEach((sg, si) => {
      const x0 = Math.floor(Math.min(X(sg.a), X(sg.b)) / CELL), x1 = Math.floor(Math.max(X(sg.a), X(sg.b)) / CELL);
      const y0 = Math.floor(Math.min(Y(sg.a), Y(sg.b)) / CELL), y1 = Math.floor(Math.max(Y(sg.a), Y(sg.b)) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        let arr = cells.get(ck(cx, cy));
        if (!arr) cells.set(ck(cx, cy), (arr = []));
        arr.push(si);
      }
    });
    // 3. Crossings → junction nodes on both segments.
    const tested = new Set<string>();
    for (const list of cells.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = segs[list[i]], B = segs[list[j]];
        if (A.way === B.way || A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
        const key = list[i] < list[j] ? `${list[i]}:${list[j]}` : `${list[j]}:${list[i]}`;
        if (tested.has(key)) continue;
        tested.add(key);
        const ax = X(A.a), ay = Y(A.a), bx = X(A.b), by = Y(A.b), cx = X(B.a), cy = Y(B.a), dx = X(B.b), dy = Y(B.b);
        const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
        if (Math.abs(den) < 1e-12) continue;
        const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den, u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        const n = node(lat[A.a] + (lat[A.b] - lat[A.a]) * t, lng[A.a] + (lng[A.b] - lng[A.a]) * t);
        A.splits.push({ t, n }); B.splits.push({ t: u, n });
      }
    }
    // 4. Dead ends that stop just short of another road: snap onto the nearest segment.
    const degree = new Int32Array(lat.length);
    for (const sg of segs) { degree[sg.a]++; degree[sg.b]++; }
    const joins: [number, number][] = [];
    for (const e of new Set(ends)) {
      if (degree[e] !== 1) continue;
      const ex = X(e), ey = Y(e);
      let best: { si: number; t: number; d: number } | null = null;
      const cx = Math.floor(ex / CELL), cy = Math.floor(ey / CELL);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const si of cells.get(ck(cx + ox, cy + oy)) ?? []) {
          const sg = segs[si];
          if (sg.a === e || sg.b === e) continue;
          const ax = X(sg.a), ay = Y(sg.a), vx = X(sg.b) - ax, vy = Y(sg.b) - ay, L2 = vx * vx + vy * vy;
          const t = L2 > 0 ? Math.min(1, Math.max(0, ((ex - ax) * vx + (ey - ay) * vy) / L2)) : 0;
          const d = Math.hypot(ax + vx * t - ex, ay + vy * t - ey);
          if (d < JOIN_KM && (!best || d < best.d)) best = { si, t, d };
        }
      }
      if (!best) continue;
      const sg = segs[best.si];
      const target = best.t <= 1e-6 ? sg.a : best.t >= 1 - 1e-6 ? sg.b : node(lat[sg.a] + (lat[sg.b] - lat[sg.a]) * best.t, lng[sg.a] + (lng[sg.b] - lng[sg.a]) * best.t);
      if (target !== sg.a && target !== sg.b) sg.splits.push({ t: best.t, n: target });
      if (target !== e) joins.push([e, target]);
    }
    this.lat = Float64Array.from(lat);
    this.lng = Float64Array.from(lng);
    this.nodes = lat.length;
    for (let i = 0; i < this.nodes; i++) this.gridAdd(i);
    // 5. Edges: every segment split at its junctions.
    const a: number[] = [], b: number[] = [], c: number[] = [], d: number[] = [], m: number[] = [];
    const edge = (u: number, v: number, speed: number, main: number) => {
      if (u === v) return;
      const km = haversineKm(lat[u], lng[u], lat[v], lng[v]);
      a.push(u); b.push(v); c.push((km / speed) * 60); d.push(km); m.push(main);
    };
    for (const sg of segs) {
      sg.splits.sort((p, r) => p.t - r.t);
      let prev = sg.a;
      for (const sp of sg.splits) { edge(prev, sp.n, sg.speed, sg.main); prev = sp.n; }
      edge(prev, sg.b, sg.speed, sg.main);
    }
    for (const [u, v] of joins) edge(u, v, 20, 0);
    // CSR, both directions.
    const count = new Int32Array(this.nodes + 1);
    for (let e = 0; e < a.length; e++) { count[a[e] + 1]++; count[b[e] + 1]++; }
    for (let i = 0; i < this.nodes; i++) count[i + 1] += count[i];
    this.off = count.slice();
    const fill = count.slice(0, this.nodes);
    const n = a.length * 2;
    this.to = new Int32Array(n); this.cost = new Float32Array(n); this.len = new Float32Array(n); this.main = new Uint8Array(n);
    const put = (from: number, to: number, e: number) => { const k = fill[from]++; this.to[k] = to; this.cost[k] = c[e]; this.len[k] = d[e]; this.main[k] = m[e]; };
    for (let e = 0; e < a.length; e++) { put(a[e], b[e], e); put(b[e], a[e], e); }
    this.edges = a.length;
    // Connected components: stops snap to the main network, never to an isolated lot or track.
    this.comp = new Int32Array(this.nodes).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let i = 0; i < this.nodes; i++) {
      if (this.comp[i] >= 0) continue;
      const id = sizes.length;
      let size = 0;
      this.comp[i] = id; stack.push(i);
      while (stack.length) {
        const u = stack.pop()!; size++;
        for (let k = this.off[u]; k < this.off[u + 1]; k++) if (this.comp[this.to[k]] < 0) { this.comp[this.to[k]] = id; stack.push(this.to[k]); }
      }
      sizes.push(size);
    }
    this.mainComp = sizes.indexOf(Math.max(...sizes, 0));
  }

  private cellKey(la: number, ln: number) { return Math.floor(la * 200) * 100003 + Math.floor(ln * 200); }
  private gridAdd(i: number) {
    const k = this.cellKey(this.lat[i], this.lng[i]);
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push(i);
  }

  /** Nearest node within `maxKm` (or -1); `main` = only on the main connected network. */
  nearest(la: number, ln: number, maxKm = 1, not = -1, main = false): number {
    const r = Math.ceil(maxKm / 0.4) + 1; // cells are 0.005° ≈ 0.55 km × 0.35 km
    const cla = Math.floor(la * 200), cln = Math.floor(ln * 200);
    let best = -1, bestKm = maxKm;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      for (const i of this.grid.get((cla + dy) * 100003 + cln + dx) ?? []) {
        if (i === not || (main && this.comp[i] !== this.mainComp)) continue;
        const km = haversineKm(la, ln, this.lat[i], this.lng[i]);
        if (km < bestKm) { bestKm = km; best = i; }
      }
    }
    return best;
  }

  /** Fastest route between two points (A*), or null if they aren't connected. */
  route(from: LatLng, to: LatLng): Leg | null {
    const s = this.nearest(from.lat, from.lng, 1.5, -1, true), t = this.nearest(to.lat, to.lng, 1.5, -1, true);
    if (s < 0 || t < 0) return null;
    if (s === t) return { path: [from, to], km: haversineKm(from.lat, from.lng, to.lat, to.lng), minutes: 0, mainRoadShare: 0 };
    const g = new Float64Array(this.nodes).fill(Infinity), came = new Int32Array(this.nodes).fill(-1), via = new Int32Array(this.nodes).fill(-1);
    const h = (i: number) => (haversineKm(this.lat[i], this.lng[i], this.lat[t], this.lng[t]) / TOP_SPEED) * 60;
    const heap = new MinHeap();
    g[s] = 0;
    heap.push(s, h(s));
    while (heap.size) {
      const u = heap.pop();
      if (u === t) break;
      for (let k = this.off[u]; k < this.off[u + 1]; k++) {
        const v = this.to[k], ng = g[u] + this.cost[k];
        if (ng < g[v]) { g[v] = ng; came[v] = u; via[v] = k; heap.push(v, ng + h(v)); }
      }
    }
    if (!Number.isFinite(g[t])) return null;
    const path: LatLng[] = [];
    let km = 0, mainKm = 0;
    for (let v = t; v >= 0; v = came[v]) {
      path.push({ lat: this.lat[v], lng: this.lng[v] });
      const k = via[v];
      if (k >= 0) { km += this.len[k]; if (this.main[k]) mainKm += this.len[k]; }
    }
    path.reverse();
    // The short walk from the ticket to the nearest road point.
    path.unshift(from); path.push(to);
    return { path, km, minutes: g[t], mainRoadShare: km > 0 ? mainKm / km : 0 };
  }
}

/** Binary min-heap of node ids by priority (lazy deletion: stale entries are skipped by A*'s check). */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p]; i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys, top = ids[0];
    const id = ids.pop()!, key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let c = i, ck = key;
        if (l < ids.length && keys[l] < ck) { c = l; ck = keys[l]; }
        if (r < ids.length && keys[r] < ck) { c = r; ck = keys[r]; }
        if (c === i) break;
        ids[i] = ids[c]; keys[i] = keys[c]; i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}

// ------------------------------------------------------------ crew routes
export interface CrewRoute {
  legs: Leg[];
  km: number;
  minutes: number;
  /** Stop order as given (indexes into the crew's job list). */
  order: number[];
}

/** Drive the stops in order, starting from `depot`. Unroutable legs fall back to a straight line. */
export function routeStops(g: RoadGraph, depot: LatLng, stops: LatLng[], order = stops.map((_, i) => i)): CrewRoute {
  const legs: Leg[] = [];
  let at = depot;
  for (const i of order) {
    const to = stops[i];
    legs.push(g.route(at, to) ?? { path: [at, to], km: haversineKm(at.lat, at.lng, to.lat, to.lng) * 1.3, minutes: (haversineKm(at.lat, at.lng, to.lat, to.lng) * 1.3 / 35) * 60, mainRoadShare: 0 });
    at = to;
  }
  return { legs, order, km: legs.reduce((t, l) => t + l.km, 0), minutes: legs.reduce((t, l) => t + l.minutes, 0) };
}

/**
 * The visiting order with the least driving time (every order for up to 7 stops, else 2-opt), from
 * a matrix of road travel times. Returns the order; the caller routes it.
 */
export function shortestOrder(g: RoadGraph, depot: LatLng, stops: LatLng[]): number[] {
  const pts = [depot, ...stops], n = pts.length;
  const T: number[][] = pts.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) T[i][j] = g.route(pts[i], pts[j])?.minutes ?? Infinity;
  const cost = (ord: number[]) => { let t = 0, at = 0; for (const s of ord) { t += T[at][s + 1]; at = s + 1; } return t; };
  const idx = stops.map((_, i) => i);
  if (stops.length <= 7) {
    let best = idx, bestT = cost(idx);
    const perm = (rest: number[], acc: number[]) => {
      if (!rest.length) { const t = cost(acc); if (t < bestT) { bestT = t; best = acc; } return; }
      for (let k = 0; k < rest.length; k++) perm([...rest.slice(0, k), ...rest.slice(k + 1)], [...acc, rest[k]]);
    };
    perm(idx, []);
    return best;
  }
  let ord = idx, improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ord.length - 1; i++) for (let j = i + 1; j < ord.length; j++) {
      const cand = [...ord.slice(0, i), ...ord.slice(i, j + 1).reverse(), ...ord.slice(j + 1)];
      if (cost(cand) < cost(ord) - 1e-9) { ord = cand; improved = true; }
    }
  }
  return ord;
}
