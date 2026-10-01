/**
 * GPU representation of one ChunkData: one instanced hex draw call plus one
 * instanced line draw call per prop kind. Restyling rewrites attributes in place.
 */
import {
  BufferGeometry, Group, InstancedBufferAttribute, InstancedBufferGeometry, LineSegments, Mesh, Sphere, Vector3,
  type ShaderMaterial,
} from "three";
import { GRID } from "../config/grid";
import { chunkWorldBounds, hash01, hexKey } from "../hex/hexMath";
import { NODE_TYPES, type NodeOverride, type PropKind } from "../hex/nodeTypes";
import type { LandClass } from "../geo/landClass";
import type { NodeStatus } from "../hex/nodeTypes";
import type { ChunkData } from "../world/types";
import { BUILDING_BRIGHTNESS, BUILDING_KINDS, FOOTPRINT_SCALE } from "../hex/overlayStyles";
import { BLD_STRIDE } from "../world/overlays";
import { buildingLines, hexPrism, propLines } from "./geometry";
import { resolveStyle, type NodeStyler } from "./nodeStyle";

let prism: BufferGeometry | null = null;

export interface StyleSource {
  overrides: Map<string, NodeOverride>;
  styler: NodeStyler | null;
  /** Workspace indices of regions in focus; the rest render slightly greyed. */
  focus: Set<number>;
}

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
}

export class ChunkMesh {
  readonly group = new Group();
  private hexGeo: InstancedBufferGeometry;
  private aLine: InstancedBufferAttribute;
  private aEdges: InstancedBufferAttribute;
  private aStyle: InstancedBufferAttribute;
  private aMeta: InstancedBufferAttribute;
  private props: PropBatch[] = [];


  constructor(
    readonly data: ChunkData,
    mats: ChunkMaterials,
    private src: StyleSource,
    born: number,
  ) {
    prism ??= hexPrism();
    const n = data.count;
    const g = (this.hexGeo = new InstancedBufferGeometry());
    for (const name of ["position", "normal", "aFace", "aUV"]) g.setAttribute(name, prism.getAttribute(name));
    g.instanceCount = n;

    const aPos = new Float32Array(n * 3);
    const aMeta = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      aPos[i * 3] = data.x[i];
      aPos[i * 3 + 1] = data.z[i];
      aPos[i * 3 + 2] = data.elev[i] / 1000;
      aMeta[i * 2] = born;
      aMeta[i * 2 + 1] = hash01(data.q[i], data.r[i], 7);
    }
    g.setAttribute("aPos", new InstancedBufferAttribute(aPos, 3));
    g.setAttribute("aMeta", (this.aMeta = new InstancedBufferAttribute(aMeta, 2)));
    g.setAttribute("aLine", (this.aLine = new InstancedBufferAttribute(new Float32Array(n * 4), 4)));
    g.setAttribute("aEdges", (this.aEdges = new InstancedBufferAttribute(new Float32Array(n * 2), 2)));
    g.setAttribute("aStyle", (this.aStyle = new InstancedBufferAttribute(new Float32Array(n * 4), 4)));

    // Culling bounds: chunk footprint, generous height.
    const size = GRID.levels[data.level].size;
    const b = chunkWorldBounds(data.cx, data.cz, GRID.chunkCells, size);
    const c = new Vector3((b.minX + b.maxX) / 2, 20, (b.minZ + b.maxZ) / 2);
    g.boundingSphere = new Sphere(c, Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 120);

    const mesh = new Mesh(g, mats.hex);
    mesh.frustumCulled = true;
    this.group.add(mesh);

    if (GRID.levels[data.level].decorations) this.buildProps(mats.prop, g.boundingSphere, born);
    if (data.buildings.length) this.buildBuildings(mats.building, g.boundingSphere, born);
    this.restyle();
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
      this.props.push({ kind, hexIndex: Int32Array.from(e.hex), color, meta: metaAttr, obj });
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
      this.props.push({ kind: `building:${k}`, hexIndex, color, meta: metaAttr, obj, gain: BUILDING_BRIGHTNESS });
    }
  }

  /** Recompute colours / pulse / lift from the registry, overrides and styler. */
  restyle() {
    const d = this.data;
    const line = this.aLine.array as Float32Array, style = this.aStyle.array as Float32Array;
    const edges = this.aEdges.array as Float32Array;
    const propCol = new Float32Array(d.count * 3), lift = new Float32Array(d.count);
    for (let i = 0; i < d.count; i++) {
      const key = hexKey(d.level, d.q[i], d.r[i]);
      const s = resolveStyle(
        { key, land: d.land[i] as LandClass, status: d.status[i] as NodeStatus, risk: d.risk[i], dimmed: !this.src.focus.has(d.region[i]) },
        this.src.overrides.get(key),
        this.src.styler,
      );
      line.set(s.line, i * 4);
      line[i * 4 + 3] = s.emphasis;
      edges[i * 2] = d.edges[i];
      edges[i * 2 + 1] = d.contours[i];
      style[i * 4] = s.fill; style[i * 4 + 1] = s.pulse; style[i * 4 + 2] = s.lift; style[i * 4 + 3] = s.pattern;
      propCol[i * 3] = s.prop[0] * s.emphasis;
      propCol[i * 3 + 1] = s.prop[1] * s.emphasis;
      propCol[i * 3 + 2] = s.prop[2] * s.emphasis;
      lift[i] = s.lift;
    }
    this.aLine.needsUpdate = true;
    this.aEdges.needsUpdate = true;
    this.aStyle.needsUpdate = true;
    for (const p of this.props) {
      const c = p.color.array as Float32Array, m = p.meta.array as Float32Array;
      for (let j = 0; j < p.hexIndex.length; j++) {
        const hi = p.hexIndex[j], gain = p.gain ?? 1;
        c[j * 3] = propCol[hi * 3] * gain; c[j * 3 + 1] = propCol[hi * 3 + 1] * gain; c[j * 3 + 2] = propCol[hi * 3 + 2] * gain;
        m[j * 3 + 2] = lift[hi];
      }
      p.color.needsUpdate = true;
      p.meta.needsUpdate = true;
    }
  }

  /** Replay the build-in animation (e.g. when a cached chunk re-enters view). */
  rebirth(time: number) {
    const m = this.aMeta.array as Float32Array;
    for (let i = 0; i < this.data.count; i++) m[i * 2] = time;
    this.aMeta.needsUpdate = true;
    for (const p of this.props) {
      const pm = p.meta.array as Float32Array;
      for (let j = 0; j < p.hexIndex.length; j++) pm[j * 3] = time;
      p.meta.needsUpdate = true;
    }
  }

  dispose() {
    this.hexGeo.dispose();
    for (const p of this.props) p.obj.geometry.dispose();
    this.group.removeFromParent();
  }
}
