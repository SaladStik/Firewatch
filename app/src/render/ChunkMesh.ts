/**
 * GPU representation of one ChunkData: one instanced hex draw call plus one
 * instanced line draw call per prop kind. Restyling rewrites attributes in place.
 */
import { STREET_LEVEL } from "../config/cities";
import {
  BufferGeometry, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, Sphere, Vector3,
  type ShaderMaterial,
} from "three";
import { GRID } from "../config/grid";
import { chunkWorldBounds, hash01, hexKey, SQRT3, worldToHex } from "../hex/hexMath";
import { NODE_TYPES, type NodeOverride, type PropKind } from "../hex/nodeTypes";
import { LandClass } from "../geo/landClass";
import { NodeStatus } from "../hex/nodeTypes";
import type { ChunkData } from "../world/types";
import { BUILDING_BRIGHTNESS, BUILDING_KINDS, FOOTPRINT_SCALE } from "../hex/overlayStyles";
import { BLD_STRIDE } from "../world/overlays";
import { MIN_THICKNESS, reliefKm } from "./heights";
import { buildingLines, hexTop, hexWall, propLines } from "./geometry";
import { resolveStyle, type NodeStyler, type ResolvedStyle } from "./nodeStyle";
import { sharedUniforms } from "./materials";

/** Building colour at the closest zoom level (linear RGB; × BUILDING_BRIGHTNESS in the shader feed). */
const WHITE_BUILDING = 1.0;

let topGeo: BufferGeometry | null = null;
let wallGeo: BufferGeometry | null = null;

export interface StyleSource {
  overrides: Map<string, NodeOverride>;
  styler: NodeStyler | null;
  /** Workspace indices of regions in focus; the rest render slightly greyed. */
  focus: Set<number>;
  /** The rest aren't drawn at all (the pitch page reveals provinces one stage at a time). */
  hideUnfocused?: boolean;
}

/**
 * Styles by (land, status, risk band, dimmed): a chunk has a few dozen distinct combinations among
 * hundreds of hexes, so resolving each once makes recolouring several times cheaper. Cleared when
 * the styler changes (layer toggles). Hexes with an override are resolved on their own.
 */
const styleCache = new Map<number, ResolvedStyle>();
let styleCacheFor: NodeStyler | null | undefined;
function cachedStyle(ctx: { key: string; land: LandClass; status: NodeStatus; risk: number; dimmed: boolean }, styler: NodeStyler | null) {
  if (styleCacheFor !== styler) { styleCache.clear(); styleCacheFor = styler; }
  // Risk only matters to a styler; 1/64 steps are finer than any colour ramp on screen.
  const rq = styler ? Math.round(Math.min(1, Math.max(0, ctx.risk)) * 64) : 0;
  const k = ((ctx.land * 32 + ctx.status) * 65 + rq) * 2 + (ctx.dimmed ? 1 : 0);
  let s = styleCache.get(k);
  if (!s) styleCache.set(k, (s = resolveStyle(ctx, undefined, styler)));
  return s;
}

/** A hex "born" this far in the future isn't there yet (its build-in animation hasn't started). */
const UNBORN = 1e9;

export interface ChunkMaterials {
  hex: ShaderMaterial;
  prop: ShaderMaterial;
  building: ShaderMaterial;
}

interface PropBatch {
  kind: PropKind | string;
  hexIndex: Int32Array;
  color: InstancedBufferAttribute;
  meta: InstancedBufferAttribute;
  obj: LineSegments;
  /** Brightness multiplier on the hex's prop colour. */
  gain?: number;
  /** Largest on-screen extent (km) of anything in this batch — for skipping sub-pixel draws. */
  maxSizeKm: number;
}

export class ChunkMesh {
  readonly group = new Group();
  private hexGeo: InstancedBufferGeometry;
  private aLine: InstancedBufferAttribute;
  private aEdges: InstancedBufferAttribute;
  private aStyle: InstancedBufferAttribute;
  private aMeta: InstancedBufferAttribute;
  private props: PropBatch[] = [];
  private aPos: InstancedBufferAttribute;
  /** Walls: one instance per VISIBLE wall (copies of its hex's attributes + side index). */
  private wallsGeo = new InstancedBufferGeometry();
  private wallCap = 0;
  /** 1 = honour the finer ring's hole; 0 = draw everywhere (standing in for loading finer chunks). */
  holeOn = 1;
  /** Per hex: hidden because its region is out of focus (StyleSource.hideUnfocused). */
  private hidden: Uint8Array;
  /** The regions this chunk's hexes belong to (to skip a chunk that's all hidden). */
  readonly regions: number[];
  /** Its colours are out of date (restyled when next shown, see HexWorld's restyle queue). */
  styleDirty = false;
  disposed = false;
  /** Shared culling sphere for every draw in this chunk; refit as the vertical scale changes. */
  private bounds: Sphere;
  private halfDiag: number;
  private maxRelief = 0;
  private fitVs = -1;

  constructor(
    readonly data: ChunkData,
    mats: ChunkMaterials,
    private src: StyleSource,
    born: number,
  ) {
    topGeo ??= hexTop();
    wallGeo ??= hexWall();
    const n = data.count;
    const g = (this.hexGeo = new InstancedBufferGeometry());
    for (const name of ["position", "normal", "aFace", "aUV", "aSide"]) g.setAttribute(name, topGeo.getAttribute(name));
    g.instanceCount = n;
    for (const name of ["position", "normal", "aFace", "aUV"]) this.wallsGeo.setAttribute(name, wallGeo.getAttribute(name));

    const aPos = new Float32Array(n * 3);
    const aMeta = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      aPos[i * 3] = data.x[i];
      aPos[i * 3 + 1] = data.z[i];
      aPos[i * 3 + 2] = data.elev[i] / 1000;
      aMeta[i * 2] = born;
      aMeta[i * 2 + 1] = hash01(data.q[i], data.r[i], 7);
    }
    g.setAttribute("aPos", (this.aPos = new InstancedBufferAttribute(aPos, 3)));
    g.setAttribute("aMeta", (this.aMeta = new InstancedBufferAttribute(aMeta, 2)));
    g.setAttribute("aLine", (this.aLine = new InstancedBufferAttribute(new Float32Array(n * 4), 4)));
    g.setAttribute("aEdges", (this.aEdges = new InstancedBufferAttribute(new Float32Array(n * 2), 2)));
    g.setAttribute("aStyle", (this.aStyle = new InstancedBufferAttribute(new Float32Array(n * 4), 4)));

    // Culling bounds: chunk footprint, generous height.
    const size = GRID.levels[data.level].size;
    const b = chunkWorldBounds(data.cx, data.cz, GRID.chunkCells, size);
    // Generous vertical allowance: with relief shaping + national exaggeration the Rockies
    // can stand a few hundred km tall in world units; under-sized bounds would cull them.
    // Tight bounds (footprint × this chunk's real relief) so off-screen chunks are actually
    // culled — each chunk is ~4 draw calls and the map is draw-call bound.
    for (let i = 0; i < n; i++) this.maxRelief = Math.max(this.maxRelief, reliefKm(data.elev[i]));
    this.halfDiag = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
    this.bounds = g.boundingSphere = new Sphere(new Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2), 1);
    this.fitBounds(1);

    const mesh = new Mesh(g, mats.hex);
    mesh.frustumCulled = true;
    this.group.add(mesh);
    // Shared material: set this chunk's hole flag right before it draws.
    const setHole = (_r: unknown, _s: unknown, _c: unknown, _g: unknown, material: unknown) => {
      const m = material as ShaderMaterial;
      if (m.uniforms.uHoleOn.value !== this.holeOn) { m.uniforms.uHoleOn.value = this.holeOn; m.uniformsNeedUpdate = true; }
    };
    mesh.onBeforeRender = setHole;
    this.wallsGeo.boundingSphere = g.boundingSphere;
    const walls = new Mesh(this.wallsGeo, mats.hex);
    walls.frustumCulled = true;
    walls.onBeforeRender = setHole;
    this.group.add(walls);

    if (GRID.levels[data.level].decorations) this.buildProps(mats.prop, g.boundingSphere, born);
    if (data.buildings.length) this.buildBuildings(mats.building, g.boundingSphere, born);
    this.hidden = new Uint8Array(data.count);
    this.regions = [...new Set(data.region)];
    this.restyle();
    // A chunk never moves: compute its matrices once and skip it in the scene's per-frame matrix
    // pass (three walks every child, hidden or not, and a big cache made that a real cost).
    this.group.updateMatrixWorld(true);
    this.group.updateMatrixWorld = () => {};
    // Chunks never move: skip three's per-frame matrix walk over thousands of meshes.
    this.group.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.matrixWorldAutoUpdate = false;
    });
  }

  private buildProps(mat: ShaderMaterial, bounds: Sphere, born: number) {
    const d = this.data;
    const byKind = new Map<PropKind, { hex: number[]; off: number[] }>();
    for (let i = 0; i < d.count; i++) {
      const specs = NODE_TYPES[d.land[i] as LandClass]?.props;
      if (!specs) continue;
      specs.forEach((spec, si) => {
        const h = hash01(d.q[i], d.r[i], 31 + si);
        const cnt = spec.count[0] + Math.floor(h * (spec.count[1] - spec.count[0] + 1));
        let e = byKind.get(spec.kind);
        if (!e) byKind.set(spec.kind, (e = { hex: [], off: [] }));
        const rot = hash01(d.q[i], d.r[i], 99 + si) * Math.PI * 2;
        for (let k = 0; k < cnt; k++) {
          const a = rot + (k / Math.max(1, cnt)) * Math.PI * 2 + si * 1.3;
          const rad = cnt === 1 && si === 0 ? 0.12 : 0.3 + 0.18 * hash01(d.q[i], d.r[i], k + 5);
          e.hex.push(i);
          e.off.push(Math.cos(a) * rad, Math.sin(a) * rad, spec.scale * (0.8 + 0.4 * hash01(d.q[i] + k, d.r[i], 3)), a * 2.1);
        }
      });
    }
    for (const [kind, e] of byKind) {
      const m = e.hex.length;
      if (!m) continue;
      const g = new InstancedBufferGeometry();
      g.setAttribute("position", propLines(kind).getAttribute("position"));
      g.instanceCount = m;
      const aPos = new Float32Array(m * 3);
      e.hex.forEach((hi, j) => {
        aPos[j * 3] = d.x[hi]; aPos[j * 3 + 1] = d.z[hi]; aPos[j * 3 + 2] = d.elev[hi] / 1000;
      });
      const meta = new Float32Array(m * 3);
      for (let j = 0; j < m; j++) {
        meta[j * 3] = born;
        meta[j * 3 + 1] = hash01(d.q[e.hex[j]], d.r[e.hex[j]], 7);
      }
      const color = new InstancedBufferAttribute(new Float32Array(m * 3), 3);
      const metaAttr = new InstancedBufferAttribute(meta, 3);
      g.setAttribute("aPos", new InstancedBufferAttribute(aPos, 3));
      g.setAttribute("aOff", new InstancedBufferAttribute(new Float32Array(e.off), 4));
      g.setAttribute("aColor", color);
      g.setAttribute("aMeta", metaAttr);
      g.boundingSphere = bounds;
      const obj = new LineSegments(g, mat);
      this.group.add(obj);
      let maxScale = 0;
      for (let j = 2; j < e.off.length; j += 4) maxScale = Math.max(maxScale, e.off[j]);
      const maxSizeKm = maxScale * GRID.levels[d.level].size * 0.34; // matches the prop shader
      this.props.push({ kind, hexIndex: Int32Array.from(e.hex), color, meta: metaAttr, obj, maxSizeKm });
    }
  }

  /** Real buildings + landmarks: one instanced line draw per model kind; colour follows the hex. */
  private buildBuildings(mat: ShaderMaterial, bounds: Sphere, born: number) {
    const d = this.data, b = d.buildings, n = b.length / BLD_STRIDE;
    const byKind = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const k = b[i * BLD_STRIDE + 5];
      let arr = byKind.get(k);
      if (!arr) byKind.set(k, (arr = []));
      arr.push(i);
    }
    for (const [k, rows] of byKind) {
      const m = rows.length;
      const g = new InstancedBufferGeometry();
      g.setAttribute("position", buildingLines(BUILDING_KINDS[k]).getAttribute("position"));
      g.instanceCount = m;
      const aPos = new Float32Array(m * 3), aDim = new Float32Array(m * 3), meta = new Float32Array(m * 3);
      const hexIndex = new Int32Array(m);
      rows.forEach((i, j) => {
        const o = i * BLD_STRIDE, hi = b[o + 6];
        hexIndex[j] = hi;
        aPos.set([b[o], b[o + 1], d.elev[hi] / 1000], j * 3);
        aDim.set([b[o + 2] * FOOTPRINT_SCALE, b[o + 3] * FOOTPRINT_SCALE, b[o + 4]], j * 3);
        meta.set([born, hash01(d.q[hi], d.r[hi], 7), 0], j * 3);
      });
      const color = new InstancedBufferAttribute(new Float32Array(m * 3), 3);
      const metaAttr = new InstancedBufferAttribute(meta, 3);
      g.setAttribute("aPos", new InstancedBufferAttribute(aPos, 3));
      g.setAttribute("aDim", new InstancedBufferAttribute(aDim, 3));
      g.setAttribute("aColor", color);
      g.setAttribute("aMeta", metaAttr);
      g.boundingSphere = bounds;
      const obj = new LineSegments(g, mat);
      this.group.add(obj);
      let maxSizeKm = 0;
      for (let j = 0; j < m; j++) maxSizeKm = Math.max(maxSizeKm, aDim[j * 3], aDim[j * 3 + 1], aDim[j * 3 + 2] * 3);
      this.props.push({ kind: `building:${k}`, hexIndex, color, meta: metaAttr, obj, gain: BUILDING_BRIGHTNESS, maxSizeKm });
    }
  }

  /**
   * Skip prop / building draws whose largest item would be under ~2 px from the nearest point
   * of this chunk (the shaders fade those out anyway — this just saves the draw calls).
   */
  cullDetail(cam: Vector3, pxPerKm: number) {
    if (!this.props.length) return;
    const c = this.bounds.center;
    const near = Math.max(0.01, Math.hypot(cam.x - c.x, cam.y, cam.z - c.z) - this.halfDiag);
    const minKm = (2 * near) / pxPerKm;
    for (const p of this.props) p.obj.visible = p.maxSizeKm >= minKm;
  }

  /** Refit the culling sphere to the current vertical exaggeration. */
  fitBounds(vScale: number) {
    if (Math.abs(vScale - this.fitVs) < this.fitVs * 0.02) return;
    this.fitVs = vScale;
    const size = GRID.levels[this.data.level].size;
    // Tallest point: relief, plus hazard lift (≤ ~2 hexes) and building height (≤ ~1 km).
    const top = Math.max(MIN_THICKNESS * size, this.maxRelief * vScale) + size * 3 + 1;
    this.bounds.center.y = top / 2;
    this.bounds.radius = Math.hypot(this.halfDiag, top / 2);
  }

  /** Recompute colours / pulse / lift from the registry, overrides and styler. */
  restyle() {
    const d = this.data;
    this.syncHidden();
    const line = this.aLine.array as Float32Array, style = this.aStyle.array as Float32Array;
    const edges = this.aEdges.array as Float32Array;
    const propCol = new Float32Array(d.count * 3), bldCol = new Float32Array(d.count * 3), lift = new Float32Array(d.count);
    const whiteBuildings = d.level >= STREET_LEVEL;
    const anyOverride = this.src.overrides.size > 0;
    const style1 = (i: number, land: LandClass) => {
      const key = anyOverride ? hexKey(d.level, d.q[i], d.r[i]) : "";
      const o = anyOverride ? this.src.overrides.get(key) : undefined;
      const ctx = { key, land, status: d.status[i] as NodeStatus, risk: d.risk[i], dimmed: !this.src.focus.has(d.region[i]) };
      return o ? resolveStyle(ctx, o, this.src.styler) : cachedStyle(ctx, this.src.styler);
    };
    for (let i = 0; i < d.count; i++) {
      const s = style1(i, d.land[i] as LandClass);
      line.set(s.line, i * 4);
      line[i * 4 + 3] = s.emphasis;
      edges[i * 2] = d.edges[i];
      edges[i * 2 + 1] = d.contours[i];
      style[i * 4] = s.fill; style[i * 4 + 1] = s.pulse; style[i * 4 + 2] = s.lift; style[i * 4 + 3] = s.pattern;
      propCol[i * 3] = s.prop[0] * s.emphasis;
      propCol[i * 3 + 1] = s.prop[1] * s.emphasis;
      propCol[i * 3 + 2] = s.prop[2] * s.emphasis;
      // Buildings on a road / rail hex keep the settlement look (same status: a burning block is still red).
      const land = d.land[i] as LandClass;
      const bs = land === LandClass.Road || land === LandClass.Rail ? style1(i, LandClass.Urban) : s;
      // At the closest zoom, buildings are white (clean 3D city blocks); a hazard status keeps
      // its colour so a burning block still reads red, and unfocused regions stay greyed.
      const white = whiteBuildings && d.status[i] === NodeStatus.Normal && this.src.focus.has(d.region[i]);
      bldCol[i * 3] = white ? WHITE_BUILDING : bs.prop[0] * bs.emphasis;
      bldCol[i * 3 + 1] = white ? WHITE_BUILDING : bs.prop[1] * bs.emphasis;
      bldCol[i * 3 + 2] = white ? WHITE_BUILDING : bs.prop[2] * bs.emphasis;
      lift[i] = s.lift;
    }
    this.aLine.needsUpdate = true;
    this.aEdges.needsUpdate = true;
    this.aStyle.needsUpdate = true;
    this.syncWalls();
    for (const p of this.props) {
      const c = p.color.array as Float32Array, m = p.meta.array as Float32Array;
      for (let j = 0; j < p.hexIndex.length; j++) {
        const hi = p.hexIndex[j], gain = p.gain ?? 1;
        const src = String(p.kind).startsWith("building:") ? bldCol : propCol;
        c[j * 3] = src[hi * 3] * gain; c[j * 3 + 1] = src[hi * 3 + 1] * gain; c[j * 3 + 2] = src[hi * 3 + 2] * gain;
        m[j * 3 + 2] = lift[hi];
      }
      p.color.needsUpdate = true;
      p.meta.needsUpdate = true;
    }
  }

  /**
   * Hexes whose region left focus (hide mode) are un-born: gone. Ones that came back are born
   * now, so they rise in with the build-in animation (a province appearing out of the dark).
   */
  private syncHidden() {
    const d = this.data, m = this.aMeta.array as Float32Array, now = sharedUniforms.uTime.value;
    let changed = false;
    for (let i = 0; i < d.count; i++) {
      const hide = this.src.hideUnfocused && !this.src.focus.has(d.region[i]) ? 1 : 0;
      if (hide === this.hidden[i]) continue;
      this.hidden[i] = hide;
      m[i * 2] = hide ? UNBORN : now;
      changed = true;
    }
    if (!changed) return;
    this.aMeta.needsUpdate = true;
    for (const p of this.props) {
      const pm = p.meta.array as Float32Array;
      for (let j = 0; j < p.hexIndex.length; j++) {
        const hi = p.hexIndex[j];
        pm[j * 3] = this.hidden[hi] ? UNBORN : Math.min(pm[j * 3] === UNBORN ? now : pm[j * 3], now);
      }
      p.meta.needsUpdate = true;
    }
  }

  /**
   * Rebuild the wall instances: a wall is drawn only where it can be seen — the neighbour is
   * lower or open (contour bit), or this hex is lifted (hazard pop-up) higher than the
   * neighbour on that side. Walls between equally lifted neighbours are buried, so skipped.
   */
  private syncWalls() {
    const d = this.data, style = this.aStyle.array as Float32Array;
    const size = GRID.levels[d.level].size;
    const list: number[] = []; // pairs: hex index, side
    for (let i = 0; i < d.count; i++) {
      const lift = style[i * 4 + 2];
      const c = d.contours[i];
      for (let k = 0; k < 6; k++) {
        if (c & (1 << k)) { list.push(i, k); continue; }
        if (lift <= 0.001) continue;
        // Side k faces the neighbour at angle k·60° (same order as the worker's contour bits).
        const ang = (Math.PI / 3) * k;
        const j = this.indexAt(d.x[i] + Math.cos(ang) * SQRT3 * size, d.z[i] + Math.sin(ang) * SQRT3 * size, size);
        if (j < 0 || lift > style[j * 4 + 2] + 0.001) list.push(i, k);
      }
    }
    const m = list.length / 2;
    const g = this.wallsGeo;
    if (m > this.wallCap || !g.getAttribute("aSide") || !g.getAttribute("aFloor")) {
      this.wallCap = Math.ceil(m * 1.25) + 8;
      const cap = this.wallCap;
      g.setAttribute("aPos", new InstancedBufferAttribute(new Float32Array(cap * 3), 3));
      g.setAttribute("aMeta", new InstancedBufferAttribute(new Float32Array(cap * 2), 2));
      g.setAttribute("aLine", new InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      g.setAttribute("aEdges", new InstancedBufferAttribute(new Float32Array(cap * 2), 2));
      g.setAttribute("aStyle", new InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      g.setAttribute("aSide", new InstancedBufferAttribute(new Float32Array(cap), 1));
      g.setAttribute("aFloor", new InstancedBufferAttribute(new Float32Array(cap * 2), 2));
    }
    const copy = (name: string, src: Float32Array, n: number) => {
      const attr = g.getAttribute(name) as InstancedBufferAttribute, dst = attr.array as Float32Array;
      for (let j = 0; j < m; j++) { const i = list[j * 2]; for (let c = 0; c < n; c++) dst[j * n + c] = src[i * n + c]; }
      attr.needsUpdate = true;
    };
    copy("aPos", this.aPos.array as Float32Array, 3);
    copy("aMeta", this.aMeta.array as Float32Array, 2);
    copy("aLine", this.aLine.array as Float32Array, 4);
    copy("aEdges", this.aEdges.array as Float32Array, 2);
    copy("aStyle", style, 4);
    const side = g.getAttribute("aSide") as InstancedBufferAttribute, sd = side.array as Float32Array;
    const flo = g.getAttribute("aFloor") as InstancedBufferAttribute, fd = flo.array as Float32Array;
    for (let j = 0; j < m; j++) {
      const i = list[j * 2], k = list[j * 2 + 1];
      sd[j] = k;
      // The neighbour on side k (same order as the worker's contour bits), if it's in this chunk.
      const ang = (Math.PI / 3) * k;
      const nb = this.indexAt(d.x[i] + Math.cos(ang) * SQRT3 * size, d.z[i] + Math.sin(ang) * SQRT3 * size, size);
      if (nb >= 0) {
        fd[j * 2] = d.elev[nb] / 1000;
        fd[j * 2 + 1] = style[nb * 4 + 2];
      } else if (!(d.contours[i] & (1 << k))) {
        // Neighbour in another chunk and no terrain step here: the wall only exists because this
        // hex is raised, so it covers just the raise (down to its own un-raised top).
        fd[j * 2] = d.elev[i] / 1000;
        fd[j * 2 + 1] = 0;
      } else {
        fd[j * 2] = -1; // a real step at the chunk edge (cliff / coast): down to the ground
        fd[j * 2 + 1] = 0;
      }
    }
    side.needsUpdate = true;
    flo.needsUpdate = true;
    g.instanceCount = m;
  }

  private byQR: Map<number, number> | null = null;
  /** Index of the hex in this chunk at a world point, or -1 (outside the chunk). */
  private indexAt(x: number, z: number, size: number): number {
    if (!this.byQR) {
      this.byQR = new Map();
      for (let i = 0; i < this.data.count; i++) this.byQR.set(this.data.q[i] * 100_003 + this.data.r[i], i);
    }
    const h = worldToHex(x, z, size);
    return this.byQR.get(h.q * 100_003 + h.r) ?? -1;
  }

  /** Replay the build-in animation (e.g. when a cached chunk re-enters view). */
  rebirth(time: number) {
    const m = this.aMeta.array as Float32Array;
    for (let i = 0; i < this.data.count; i++) m[i * 2] = this.hidden[i] ? UNBORN : time;
    this.aMeta.needsUpdate = true;
    this.syncWalls();
    for (const p of this.props) {
      const pm = p.meta.array as Float32Array;
      for (let j = 0; j < p.hexIndex.length; j++) pm[j * 3] = this.hidden[p.hexIndex[j]] ? UNBORN : time;
      p.meta.needsUpdate = true;
    }
  }

  dispose() {
    this.disposed = true;
    this.hexGeo.dispose();
    this.wallsGeo.dispose();
    for (const p of this.props) p.obj.geometry.dispose();
    this.group.removeFromParent();
  }
}
