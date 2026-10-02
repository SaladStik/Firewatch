/// <reference lib="webworker" />
/**
 * World worker: owns every region's terrain raster, OSM overlays and the hazard
 * field, and builds chunk data off the main thread.
 *
 * Rivers, roads and rail become their own nodes here (River / Road / Rail hexes),
 * at the zoom levels where that's true to scale.
 */
import { GRID } from "../config/grid";
import { LandClass } from "../geo/landClass";
import { LineKind } from "../geo/lineKinds";
import { setProjection } from "../geo/projection";
import { axialToOffset, chunkWorldBounds, hexToWorld, offsetToAxial, SQRT3, worldToHex } from "../hex/hexMath";
import { NODE_TYPES, type NodeStatus } from "../hex/nodeTypes";
import type { Landmark } from "../hex/overlayStyles";
import { HazardField } from "./hazardField";
import { DetailTiles } from "./detailTiles";
import { OverlayIndex, type OsmData } from "./overlays";
import { Terrain, TerrainStack } from "./terrain";
import type { ChunkData, TerrainMeta, WorkerRequest, WorkerResponse } from "./types";

declare const self: DedicatedWorkerGlobalScope;

const terrain = new TerrainStack();
const overlays: OverlayIndex[] = [];
/** Per-region street-level lines, fetched as tiles on demand. */
const details: DetailTiles[] = [];
let hazards = new HazardField({ hotspots: [], perimeters: [], weather: [], spread: [], rain: [] });

async function decode(blob: Blob): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

/** Load one region's baked data. `index` is its slot in the workspace (0-based). */
async function addRegion(url: string, index: number, landmarks: Landmark[]): Promise<TerrainMeta> {
  const [meta, blob, osm] = await Promise.all([
    fetch(`${url}/terrain.json`).then((r) => r.json() as Promise<TerrainMeta>),
    fetch(`${url}/terrain.png`).then((r) => r.blob()),
    // Optional: a region without an OSM bake simply has no rivers/roads/buildings.
    fetch(`${url}/osm.json`).then((r) => (r.ok ? (r.json() as Promise<OsmData>) : null)).catch(() => null),
  ]);
  terrain.add(index, new Terrain(meta, await decode(blob)));
  overlays.push(new OverlayIndex(osm, landmarks));
  const detail = new DetailTiles(url);
  await detail.init();
  details.push(detail);
  return meta;
}

/** Hazard statuses that read as one region (edges are drawn between groups). */
function statusGroup(s: NodeStatus): number {
  return s === 0 ? 0 : s <= 3 ? s : s <= 5 ? 4 : s === 6 ? 5 : 6;
}

const FAMILY_IDS = new Map<string, number>();
function familyId(land: LandClass): number {
  const f = NODE_TYPES[land]?.family ?? "none";
  if (!FAMILY_IDS.has(f)) FAMILY_IDS.set(f, FAMILY_IDS.size);
  return FAMILY_IDS.get(f)!;
}

/** Which line wins when several cross one hex (a road over a river is a bridge → road). */
/** `minor`: local streets / tracks — they never turn a settlement hex into road (in town they ARE the street grid). */
const LINE_NODE: Record<number, { land: LandClass; rank: number; minor?: boolean }> = {
  [LineKind.Highway]: { land: LandClass.Road, rank: 0 },
  [LineKind.Bridge]: { land: LandClass.Road, rank: 0 },
  [LineKind.Primary]: { land: LandClass.Road, rank: 1 },
  [LineKind.Rail]: { land: LandClass.Rail, rank: 2 },
  [LineKind.Secondary]: { land: LandClass.Road, rank: 3 },
  [LineKind.RiverMajor]: { land: LandClass.River, rank: 4 },
  [LineKind.River]: { land: LandClass.River, rank: 5 },
  [LineKind.Tertiary]: { land: LandClass.Road, rank: 3, minor: true },
  [LineKind.Local]: { land: LandClass.Road, rank: 6, minor: true },
  [LineKind.Track]: { land: LandClass.Road, rank: 7, minor: true },
  [LineKind.Stream]: { land: LandClass.River, rank: 8 },
};

async function buildChunk(level: number, cx: number, cz: number, withBuildings = true): Promise<ChunkData | null> {
  const cfg = GRID.levels[level];
  const n = GRID.chunkCells;
  const size = cfg.size;
  const b = chunkWorldBounds(cx, cz, n, size);
  const tb = terrain.bounds;
  if (!tb || b.maxX < tb.minX || b.minX > tb.maxX || b.maxZ < tb.minZ || b.minZ > tb.maxZ) return null;

  // ---- 1. Rivers / roads / rail → nodes. Every hex a feature passes through becomes that
  // feature's node; features wider than a hex also claim the hexes across their width.
  // Only features realistic at this hex size are included (see overlayStyles.showsAsNodes).
  const pad = size * 2;
  const eb = { minX: b.minX - pad, maxX: b.maxX + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad };
  const hk = (q: number, r: number) => `${q},${r}`;
  const lineNode = new Map<string, { land: LandClass; rank: number; minor?: boolean }>();
  const claim = (x: number, z: number, kind: LineKind) => {
    const h = worldToHex(x, z, size), k = hk(h.q, h.r), nn = LINE_NODE[kind];
    const cur = lineNode.get(k);
    if (!cur || nn.rank < cur.rank) lineNode.set(k, nn);
  };
  const finest = level === GRID.levels.length - 1;
  // Street zoom: also every tertiary / local road, forest track and stream (loaded on demand).
  if (finest) await Promise.all(details.map((d) => d.ensure(eb)));
  const sources = [
    ...overlays.map((ov) => ov.segments(level, size * 0.05, size, finest, eb)),
    ...(finest ? details.map((d) => d.segments(eb)) : []),
  ];
  for (const src of sources) {
    for (const sg of src) {
      const len = Math.hypot(sg.x2 - sg.x1, sg.z2 - sg.z1);
      const steps = Math.max(1, Math.ceil(len / (size * 0.25)));
      const half = sg.widthKm / 2;
      // Perpendicular offsets across the feature's real width (only matters when it's wider than a hex).
      const nx = len > 0 ? -(sg.z2 - sg.z1) / len : 0, nz = len > 0 ? (sg.x2 - sg.x1) / len : 0;
      const across = half > size * 0.5 ? Math.ceil(half / (size * 0.5)) : 0;
      for (let i = 0; i <= steps; i++) {
        const px = sg.x1 + ((sg.x2 - sg.x1) * i) / steps, pz = sg.z1 + ((sg.z2 - sg.z1) * i) / steps;
        claim(px, pz, sg.kind);
        for (let j = 1; j <= across; j++) {
          const o = (half * j) / across;
          claim(px + nx * o, pz + nz * o, sg.kind);
          claim(px - nx * o, pz - nz * o, sg.kind);
        }
      }
    }
  }

  // ---- 2. Classify cells (memoised — neighbours are shared between cells).
  type Cell = { land: LandClass; status: NodeStatus; risk: number; key: number; elev: number; region: number };
  const memo = new Map<string, Cell>();
  const classify = (cq: number, cr: number): Cell => {
    const k = hk(cq, cr);
    let c = memo.get(k);
    if (c) return c;
    const p = hexToWorld(cq, cr, size);
    const region = terrain.regionAt(p.x, p.z);
    let land = region < 0 ? LandClass.None : cfg.majorityLandClass ? terrain.landMajority(p.x, p.z, size) : terrain.landAt(p.x, p.z);
    let elev = terrain.elevation(p.x, p.z);
    if (cfg.terrace > 0) elev = Math.round(elev / cfg.terrace) * cfg.terrace;
    const ln = land !== LandClass.None ? lineNode.get(k) : undefined;
    if (ln && !(ln.land === LandClass.River && land === LandClass.Water) && !(ln.minor && land === LandClass.Urban)) {
      land = ln.land;
      // Rivers sit one step down, as a channel in the terrain.
      if (land === LandClass.River) elev -= Math.max(cfg.terrace, 5);
    }
    const hz = land === LandClass.None ? { status: 0 as NodeStatus, risk: 0 } : hazards.evaluate(p.x, p.z, land, size);
    // Region boundaries are drawn as borders too (provincial lines).
    c = { land, status: hz.status, risk: hz.risk, key: region * 1000 + familyId(land) * 8 + statusGroup(hz.status), elev, region };
    memo.set(k, c);
    return c;
  };

  // ---- 3. Emit hexes.
  const cap = n * n;
  const q = new Int32Array(cap), r = new Int32Array(cap);
  const x = new Float32Array(cap), z = new Float32Array(cap);
  const elev = new Float32Array(cap), risk = new Float32Array(cap);
  const land = new Uint8Array(cap), status = new Uint8Array(cap), edges = new Uint8Array(cap), contours = new Uint8Array(cap);
  const regionArr = new Uint8Array(cap);
  const cellIndex = new Int32Array(cap).fill(-1);
  let count = 0;

  for (let lr = 0; lr < n; lr++) for (let lc = 0; lc < n; lc++) {
    const a = offsetToAxial(cx * n + lc, cz * n + lr);
    const p = hexToWorld(a.q, a.r, size);
    const self_ = classify(a.q, a.r);
    if (self_.land === LandClass.None) continue;
    // Edge mask: bit k = neighbour across edge k is a different region/type/status.
    // Contour mask: bit k = that neighbour sits at least one terrace lower (a visible step).
    let mask = 0, contour = 0;
    for (let k = 0; k < 6; k++) {
      const ang = (Math.PI / 3) * k;
      const h = worldToHex(p.x + Math.cos(ang) * SQRT3 * size, p.z + Math.sin(ang) * SQRT3 * size, size);
      const nb = classify(h.q, h.r);
      if (nb.key !== self_.key) mask |= 1 << k;
      // Contour bit = this side wall is visible: neighbour at least a step lower, or open edge (coast / border).
      if (nb.land === LandClass.None || self_.elev - nb.elev >= Math.max(1, cfg.terrace)) contour |= 1 << k;
    }
    q[count] = a.q; r[count] = a.r; x[count] = p.x; z[count] = p.z;
    elev[count] = self_.elev; land[count] = self_.land; status[count] = self_.status; risk[count] = self_.risk;
    edges[count] = mask; contours[count] = contour; regionArr[count] = self_.region;
    cellIndex[lr * n + lc] = count;
    count++;
  }
  if (count === 0) return null;

  // ---- 4. Buildings standing on this chunk's hexes.
  let buildings = new Float32Array(0);
  if (withBuildings) {
    const owner = (px: number, pz: number) => {
      const h = worldToHex(px, pz, size);
      const { col, row } = axialToOffset(h.q, h.r);
      const lc = col - cx * n, lr = row - cz * n;
      if (lc < 0 || lr < 0 || lc >= n || lr >= n) return -1;
      const i = cellIndex[lr * n + lc];
      // Buildings stand anywhere but water (a 130 m road hex in a downtown also holds its towers).
      return i >= 0 && land[i] !== LandClass.Water && land[i] !== LandClass.River ? i : -1;
    };
    const parts = overlays.map((ov) => ov.buildings(cfg.buildingMinHeight, cfg.landmarks, b, owner));
    buildings = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { buildings.set(p, o); o += p.length; }
  }

  return {
    level, cx, cz, count,
    q: q.slice(0, count), r: r.slice(0, count), x: x.slice(0, count), z: z.slice(0, count),
    elev: elev.slice(0, count), land: land.slice(0, count), status: status.slice(0, count), risk: risk.slice(0, count),
    edges: edges.slice(0, count), contours: contours.slice(0, count), region: regionArr.slice(0, count),
    buildings, cellIndex,
  };
}

function transferables(c: ChunkData | null): Transferable[] {
  if (!c) return [];
  return [c.q, c.r, c.x, c.z, c.elev, c.land, c.status, c.risk, c.edges, c.contours, c.region, c.buildings, c.cellIndex]
    .map((a) => a.buffer);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const reply = (result: unknown, transfer: Transferable[] = []) =>
    self.postMessage({ id: msg.id, ok: true, result } satisfies WorkerResponse, transfer);
  try {
    switch (msg.type) {
      case "init":
        setProjection(msg.projection);
        reply(true);
        break;
      case "addRegion":
        reply(await addRegion(msg.url, msg.index, msg.landmarks));
        break;
      case "chunk": {
        const c = await buildChunk(msg.level, msg.cx, msg.cz);
        reply(c, transferables(c));
        break;
      }
      case "hazards":
        hazards = new HazardField(msg.hazards);
        reply(true);
        break;
      case "restatus": {
        // Deterministic rebuild → same cell order; statuses AND edge masks refresh together.
        const c = await buildChunk(msg.level, msg.cx, msg.cz, false);
        reply(c && { status: c.status, risk: c.risk, edges: c.edges }, c ? [c.status.buffer, c.risk.buffer, c.edges.buffer] : []);
        break;
      }
      case "sample": {
        reply({
          elevation: terrain.elevation(msg.x, msg.z),
          land: terrain.landAt(msg.x, msg.z),
          region: terrain.regionAt(msg.x, msg.z),
          weatherRisk: hazards.weatherRisk(msg.x, msg.z),
          nearestHotspotKm: hazards.nearestHotspot(msg.x, msg.z, 500),
        });
        break;
      }
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e) } satisfies WorkerResponse);
  }
};
