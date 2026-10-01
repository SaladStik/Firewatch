/**
 * HexWorld — LOD + chunk streaming + node API.
 *
 *  • picks the active grid level from camera distance (config/grid.ts)
 *  • streams chunks around the focus point from the worker, caches them (LRU)
 *  • exposes a node-level API: getNode / pick / setOverride / setStyler
 */
import gsap from "gsap";
import { Group, Ray, Vector3 } from "three";
import { GRID, levelForDistance } from "../config/grid";
import { unproject } from "../geo/projection";
import { axialToOffset, chunkKey, chunksInRadius, hexKey, worldToHex, SQRT3 } from "../hex/hexMath";
import { NODE_STATUSES, type NodeOverride } from "../hex/nodeTypes";
import type { LandClass } from "../geo/landClass";
import type { NodeStatus } from "../hex/nodeTypes";
import type { WorldClient } from "../world/WorldClient";
import type { ChunkData, HexNodeInfo } from "../world/types";
import { ChunkMesh, type StyleSource } from "./ChunkMesh";
import { hexTopY } from "./heights";
import { createBuildingMaterial, createHexMaterial, createPropMaterial, sharedUniforms, type LevelUniforms } from "./materials";
import type { ChunkMaterials } from "./ChunkMesh";
import type { NodeStyler } from "./nodeStyle";

interface LevelState {
  group: Group;
  uniforms: LevelUniforms;
  mats: ChunkMaterials;
  chunks: Map<string, ChunkMesh>;
  lastUsed: Map<string, number>;
}

export interface WorldStats {
  level: number;
  hexSizeKm: number;
  chunks: number;
  hexes: number;
  pending: number;
}

export class HexWorld {
  readonly root = new Group();
  private levels: LevelState[];
  private pending = new Set<string>();
  private empty = new Set<string>();
  private stale = new Set<string>();
  private active = 0;
  private frame = 0;
  private style: StyleSource = { overrides: new Map(), styler: null, focus: new Set([0]) };
  private visibleKeys = new Set<string>();
  onStats?: (s: WorldStats) => void;
  onChunkLoaded?: (c: ChunkData) => void;

  constructor(private client: WorldClient) {
    this.levels = GRID.levels.map((cfg, i) => {
      const uniforms: LevelUniforms = {
        uSize: { value: cfg.size },
        uGap: { value: GRID.hexScale },
        uLevelAlpha: { value: i === 0 ? 1 : 0 },
      };
      const group = new Group();
      group.visible = i === 0;
      this.root.add(group);
      return {
        group, uniforms, chunks: new Map(), lastUsed: new Map(),
        mats: {
          hex: createHexMaterial(uniforms), prop: createPropMaterial(uniforms),
          building: createBuildingMaterial(uniforms),
        },
      };
    });
  }

  get level() {
    return this.active;
  }

  // ------------------------------------------------------------ streaming
  /**
   * While true, no chunks are requested (the engine sets this during boot so nothing
   * is built — and cached as "empty" — before every region's data has loaded).
   */
  hold = false;

  update(focusX: number, focusZ: number, dist: number) {
    this.frame++;
    if (this.hold) return;
    this.switchLevel(dist);
    const L = this.active;
    const size = GRID.levels[L].size;
    const radius = Math.min(dist * GRID.viewRadiusFactor, GRID.maxRadiusHexes * size * SQRT3);
    sharedUniforms.uFocus.value.set(focusX, focusZ);
    sharedUniforms.uRadius.value = radius;

    const st = this.levels[L];
    const needed = chunksInRadius(focusX, focusZ, radius, GRID.chunkCells, size);
    const now = sharedUniforms.uTime.value;
    const nextVisible = new Set<string>();
    let requested = 0;
    for (const { cx, cz } of needed) {
      const key = chunkKey(L, cx, cz);
      if (this.empty.has(key)) continue;
      nextVisible.add(key);
      const cm = st.chunks.get(key);
      if (cm && this.stale.has(key) && !this.pending.has(key) && requested < GRID.maxChunkRequestsPerFrame) {
        requested++;
        this.request(L, cx, cz, key);
      }
      if (cm) {
        if (!cm.group.visible) {
          cm.group.visible = true;
          cm.rebirth(now);
        }
        st.lastUsed.set(key, this.frame);
      } else if (!this.pending.has(key) && requested < GRID.maxChunkRequestsPerFrame && this.pending.size < 16) {
        requested++;
        this.request(L, cx, cz, key);
      }
    }
    for (const key of this.visibleKeys) {
      if (!nextVisible.has(key)) {
        const cm = st.chunks.get(key);
        if (cm) cm.group.visible = false;
      }
    }
    this.visibleKeys = nextVisible;
    if (this.frame % 30 === 0) this.evict();
    if (this.frame % 10 === 0) this.emitStats();
  }

  private request(level: number, cx: number, cz: number, key: string) {
    this.pending.add(key);
    this.client.chunk(level, cx, cz).then((data) => {
      this.pending.delete(key);
      const st = this.levels[level];
      const old = st.chunks.get(key);
      const wasStale = this.stale.delete(key);
      if (old) { old.dispose(); st.chunks.delete(key); }
      if (!data) {
        this.empty.add(key);
        return;
      }
      // A rebuilt chunk replaces its predecessor in place (no build-in animation).
      const cm = new ChunkMesh(data, st.mats, this.style, wasStale ? -100 : sharedUniforms.uTime.value);
      cm.group.visible = level === this.active && this.visibleKeys.has(key);
      st.chunks.set(key, cm);
      st.lastUsed.set(key, this.frame);
      st.group.add(cm.group);
      this.onChunkLoaded?.(data);
    });
  }

  private switchLevel(dist: number) {
    const target = levelForDistance(dist);
    if (target === this.active) return;
    // Hysteresis: only switch once we're clearly past the threshold.
    const edge = GRID.levels[Math.min(target, this.active)].minDist;
    if (Math.abs(dist - edge) < edge * GRID.hysteresis) return;
    const prev = this.levels[this.active];
    const next = this.levels[target];
    gsap.to(prev.uniforms.uLevelAlpha, {
      value: 0, duration: 0.35, ease: "power2.in", overwrite: true,
      onComplete: () => { prev.group.visible = false; },
    });
    next.group.visible = true;
    gsap.to(next.uniforms.uLevelAlpha, { value: 1, duration: 0.5, ease: "power2.out", overwrite: true });
    for (const key of this.visibleKeys) {
      const cm = prev.chunks.get(key);
      if (cm) setTimeout(() => (cm.group.visible = false), 360);
    }
    this.visibleKeys = new Set();
    for (const cm of next.chunks.values()) cm.group.visible = false;
    this.active = target;
  }

  private evict() {
    for (const st of this.levels) {
      if (st.chunks.size <= GRID.cacheChunks) continue;
      const hidden = [...st.chunks.entries()].filter(([, c]) => !c.group.visible)
        .sort((a, b) => (st.lastUsed.get(a[0]) ?? 0) - (st.lastUsed.get(b[0]) ?? 0));
      for (const [key, cm] of hidden.slice(0, st.chunks.size - GRID.cacheChunks)) {
        cm.dispose();
        st.chunks.delete(key);
        st.lastUsed.delete(key);
      }
    }
  }

  private emitStats() {
    const st = this.levels[this.active];
    let hexes = 0, chunks = 0;
    for (const key of this.visibleKeys) {
      const c = st.chunks.get(key);
      if (c) { hexes += c.data.count; chunks++; }
    }
    this.onStats?.({ level: this.active, hexSizeKm: GRID.levels[this.active].size, chunks, hexes, pending: this.pending.size });
  }

  // ------------------------------------------------------------ hazards
  /** Re-evaluate status/risk for every loaded chunk (after new hazard data). */
  async refreshStatus() {
    const jobs: Promise<void>[] = [];
    for (const st of this.levels) for (const cm of st.chunks.values()) {
      jobs.push(this.client.restatus(cm.data).then((res) => {
        if (!res || res.status.length !== cm.data.count) return;
        cm.data.status.set(res.status);
        cm.data.risk.set(res.risk);
        cm.data.edges.set(res.edges);
        cm.restyle();
      }));
    }
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------ node API
  /** Customise one node. Pass `null` to clear. */
  setOverride(level: number, q: number, r: number, o: NodeOverride | null) {
    const key = hexKey(level, q, r);
    if (o) this.style.overrides.set(key, o);
    else this.style.overrides.delete(key);
    const { cx, cz } = this.chunkCoords(q, r);
    this.levels[level]?.chunks.get(chunkKey(level, cx, cz))?.restyle();
  }

  /** Regions (workspace indices) in focus; the rest render slightly greyed. */
  setFocus(indices: number[]) {
    this.style.focus = new Set(indices);
    for (const st of this.levels) for (const cm of st.chunks.values()) cm.restyle();
  }

  /**
   * Rebuild every chunk (e.g. after another region's data loaded). Visible chunks stay on
   * screen until their replacement arrives, so nothing flashes; hidden ones are dropped.
   */
  invalidate() {
    for (const st of this.levels) {
      for (const [key, cm] of st.chunks) {
        if (cm.group.visible) this.stale.add(key);
        else { cm.dispose(); st.chunks.delete(key); st.lastUsed.delete(key); }
      }
    }
    this.empty.clear();
  }

  /** Install a global styling hook (see render/nodeStyle.ts). */
  setStyler(styler: NodeStyler | null) {
    this.style.styler = styler;
    for (const st of this.levels) for (const cm of st.chunks.values()) cm.restyle();
  }

  private chunkCoords(q: number, r: number) {
    const { col, row } = axialToOffset(q, r);
    const n = GRID.chunkCells;
    return { cx: Math.floor(col / n), cz: Math.floor(row / n), lc: col - Math.floor(col / n) * n, lr: row - Math.floor(row / n) * n };
  }

  /** Node at world x,z on the active level (only if its chunk is loaded). */
  nodeAt(x: number, z: number, level = this.active): HexNodeInfo | null {
    const size = GRID.levels[level].size;
    const { q, r } = worldToHex(x, z, size);
    return this.getNode(level, q, r);
  }

  getNode(level: number, q: number, r: number): HexNodeInfo | null {
    const { cx, cz, lc, lr } = this.chunkCoords(q, r);
    const cm = this.levels[level]?.chunks.get(chunkKey(level, cx, cz));
    if (!cm) return null;
    const i = cm.data.cellIndex[lr * GRID.chunkCells + lc];
    if (i < 0) return null;
    const d = cm.data;
    const { lat, lng } = unproject(d.x[i], d.z[i]);
    return {
      level, q, r, x: d.x[i], z: d.z[i], lat, lng, key: hexKey(level, q, r),
      elevation: d.elev[i], land: d.land[i] as LandClass, status: d.status[i] as NodeStatus, risk: d.risk[i],
      region: d.region[i],
    };
  }

  topY(node: HexNodeInfo): number {
    const lift = this.style.overrides.get(node.key)?.lift ?? NODE_STATUSES[node.status].lift;
    return hexTopY(node.elevation, lift, GRID.levels[node.level].size, sharedUniforms.uVScale.value);
  }

  /** Ray-march the height field to find the hovered hex. */
  pick(ray: Ray): HexNodeInfo | null {
    const size = GRID.levels[this.active].size;
    const maxY = hexTopY(4000, 0.3, size, sharedUniforms.uVScale.value);
    if (ray.direction.y >= 0) return null;
    const t0 = Math.max(0, (ray.origin.y - maxY) / -ray.direction.y);
    const t1 = ray.origin.y / -ray.direction.y;
    const horiz = Math.hypot(ray.direction.x, ray.direction.z) || 1e-6;
    const step = Math.max((size * 0.3) / horiz, (t1 - t0) / 4000);
    const p = new Vector3();
    for (let t = t0; t <= t1 + step; t += step) {
      ray.at(t, p);
      const node = this.nodeAt(p.x, p.z);
      if (node && p.y <= this.topY(node)) return node;
    }
    return null;
  }

  dispose() {
    for (const st of this.levels) {
      for (const cm of st.chunks.values()) cm.dispose();
      for (const m of Object.values(st.mats)) m.dispose();
    }
  }
}
