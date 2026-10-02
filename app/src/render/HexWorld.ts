/**
 * HexWorld — LOD + chunk streaming + node API.
 *
 *  • picks the active grid level from camera distance (config/grid.ts)
 *  • streams chunks around the focus point from the worker, caches them (LRU)
 *  • exposes a node-level API: getNode / pick / setOverride / setStyler
 */
import gsap from "gsap";
import { Box3, Frustum, Group, Matrix4, Ray, Vector2, Vector3, type Camera } from "three";
import { GRID, levelForDistance } from "../config/grid";
import { unproject } from "../geo/projection";
import { axialToOffset, chunkKey, chunksInRadius, chunkWorldBounds, hexKey, worldToHex, SQRT3 } from "../hex/hexMath";
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
  fadingOut: boolean;
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
  private visibleKeys = new Map<number, Set<string>>();
  onStats?: (s: WorldStats) => void;
  onChunkLoaded?: (c: ChunkData) => void;

  constructor(private client: WorldClient) {
    this.maxPending = 8 * client.size;
    this.levels = GRID.levels.map((cfg, i) => {
      const uniforms: LevelUniforms = {
        uSize: { value: cfg.size },
        uGap: { value: cfg.gap ?? GRID.hexScale },
        uLevelAlpha: { value: i === 0 ? 1 : 0 },
        uFocusL: { value: new Vector2() },
        uRadius: { value: 1000 },
        uInnerFocus: { value: new Vector2() },
        uInnerRadius: { value: 0 },
      };
      const group = new Group();
      group.visible = i === 0;
      this.root.add(group);
      return {
        group, uniforms, chunks: new Map(), lastUsed: new Map(), fadingOut: false,
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

  private frustum = new Frustum();
  private projView = new Matrix4();
  private box = new Box3();

  /**
   * View-aware, multi-resolution streaming.
   *
   *  - Ring 0: the active level (finest for this zoom) around what you're looking at.
   *  - Rings 1..N: progressively COARSER levels drawn only outside the previous ring, out to a
   *    much larger radius — at L3/L4 you still see far (a fire on the horizon) at lower detail,
   *    without paying for millions of tiny far-away hexes.
   *  - While a finer chunk is still loading, the coarser chunk under it stays drawn (no holes).
   *  - Rings are pushed forward along the view direction; only on-screen chunks get built;
   *    nearest chunks (and finer rings) are built first.
   */
  update(targetX: number, targetZ: number, dist: number, camera?: Camera) {
    this.frame++;
    if (this.hold) return;
    this.switchLevel(dist);
    const L = this.active;

    // Ground-plane view direction (none when looking straight down).
    let fx = 0, fz = 0;
    if (camera) {
      const dx = targetX - camera.position.x, dz = targetZ - camera.position.z, h = Math.hypot(dx, dz);
      const tilt = h / Math.max(1e-6, Math.hypot(h, camera.position.y));
      if (h > 1e-6) { fx = (dx / h) * tilt; fz = (dz / h) * tilt; }
      this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projView);
    }

    // Rings: each coarser ring reaches farRingReach× further (its own hex cap applies).
    const rings: { level: number; reach: number }[] = [];
    let reach = Math.min(dist * GRID.viewRadiusFactor, GRID.maxRadiusHexes * GRID.levels[L].size * SQRT3);
    rings.push({ level: L, reach });
    for (let j = L - 1; j >= Math.max(0, L - GRID.farRings); j--) {
      const r = Math.min(reach * GRID.farRingReach, GRID.maxRadiusHexes * GRID.levels[j].size * SQRT3);
      if (r <= reach * 1.05) break;
      rings.push({ level: j, reach: r });
      reach = r;
    }

    const now = sharedUniforms.uTime.value;
    let requested = 0;
    const want = new Map<number, Set<string>>();
    type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
    let missing: Box[] = []; // finer-ring chunks wanted but not built yet
    let inner: { x: number; z: number; r: number } | null = null;

    for (const { level, reach: r } of rings) {
      const size = GRID.levels[level].size;
      const st = this.levels[level];
      const back = Math.min(r, dist * 0.6);
      const radius = (r + back) / 2, off = (r - back) / 2;
      const focusX = targetX + fx * off, focusZ = targetZ + fz * off;
      st.uniforms.uFocusL.value.set(focusX, focusZ);
      st.uniforms.uRadius.value = radius;
      st.uniforms.uInnerFocus.value.set(inner?.x ?? 0, inner?.z ?? 0);
      st.uniforms.uInnerRadius.value = inner?.r ?? 0;
      if (level === L) sharedUniforms.uFocus.value.set(focusX, focusZ);
      sharedUniforms.uRadius.value = radius; // outermost ring (ground grid, labels)

      const keys = new Set<string>();
      want.set(level, keys);
      const nowMissing: Box[] = [];
      const needed = chunksInRadius(focusX, focusZ, radius, GRID.chunkCells, size)
        .map((c) => {
          const bx = chunkWorldBounds(c.cx, c.cz, GRID.chunkCells, size);
          let hole = true;
          if (inner) {
            const fill = missing.some((m) => m.minX < bx.maxX && m.maxX > bx.minX && m.minZ < bx.maxZ && m.maxZ > bx.minZ);
            const corners = [[bx.minX, bx.minZ], [bx.maxX, bx.minZ], [bx.minX, bx.maxZ], [bx.maxX, bx.maxZ]];
            const far = Math.max(...corners.map(([x, z]) => Math.hypot(x - inner!.x, z - inner!.z)));
            if (far < inner.r * 0.9 && !fill) return null; // fully covered by the finer ring
            if (fill) hole = false; // stand in for finer chunks that are still loading
          }
          let inView = true;
          if (camera) {
            this.box.min.set(bx.minX, -1, bx.minZ);
            this.box.max.set(bx.maxX, 300, bx.maxZ);
            inView = this.frustum.intersectsBox(this.box);
          }
          return { ...c, bx, hole, inView, d: Math.hypot((bx.minX + bx.maxX) / 2 - targetX, (bx.minZ + bx.maxZ) / 2 - targetZ) };
        })
        .filter((c): c is NonNullable<typeof c> => !!c)
        .sort((a, b) => a.d - b.d);
      for (const { cx, cz, bx, hole, inView } of needed) {
        const key = chunkKey(level, cx, cz);
        if (this.empty.has(key)) continue;
        if (!inView && !st.chunks.has(key)) continue; // off-screen: don't build it
        keys.add(key);
        const cm = st.chunks.get(key);
        const canRequest = requested < GRID.maxChunkRequestsPerFrame && this.pending.size < this.maxPending && !this.pending.has(key);
        if (cm && this.stale.has(key) && canRequest) { requested++; this.request(level, cx, cz, key); }
        if (cm) {
          cm.holeOn = hole ? 1 : 0;
          if (!cm.group.visible) { cm.group.visible = true; cm.rebirth(now); }
          st.lastUsed.set(key, this.frame);
        } else {
          if (inView) nowMissing.push(bx);
          if (canRequest) { requested++; this.request(level, cx, cz, key); }
        }
      }
      missing = nowMissing;
      inner = { x: focusX, z: focusZ, r: radius };
    }

    // Levels in use fade in, others fade out; chunks no longer wanted are hidden.
    this.levels.forEach((st, level) => {
      const keys = want.get(level);
      if (keys) {
        if (!st.group.visible || st.fadingOut) {
          st.fadingOut = false;
          st.group.visible = true;
          gsap.to(st.uniforms.uLevelAlpha, { value: 1, duration: 0.45, ease: "power2.out", overwrite: true });
        }
      } else if (st.group.visible && !st.fadingOut) {
        st.fadingOut = true;
        gsap.to(st.uniforms.uLevelAlpha, {
          value: 0, duration: 0.35, ease: "power2.in", overwrite: true,
          onComplete: () => {
            if (!st.fadingOut) return;
            st.group.visible = false;
            for (const cm of st.chunks.values()) cm.group.visible = false;
          },
        });
        return;
      }
      if (!st.fadingOut) for (const [key, cm] of st.chunks) if (cm.group.visible && !keys?.has(key)) cm.group.visible = false;
    });
    this.visibleKeys = want;
    if (this.frame % 30 === 0) this.evict();
    if (this.frame % 10 === 0) this.emitStats();
  }

  /** Chunk builds in flight at once (scales with the worker pool). */
  maxPending = 16;

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
      let cm: ChunkMesh;
      try {
        cm = new ChunkMesh(data, st.mats, this.style, wasStale ? -100 : sharedUniforms.uTime.value);
      } catch (e) {
        // Never retry a chunk that fails to build (that would loop every frame).
        console.error(`[world] chunk ${key} failed`, e);
        this.empty.add(key);
        return;
      }
      cm.group.visible = !!this.visibleKeys.get(level)?.has(key);
      st.chunks.set(key, cm);
      st.lastUsed.set(key, this.frame);
      st.group.add(cm.group);
      this.onChunkLoaded?.(data);
    }).catch((e) => {
      this.pending.delete(key);
      console.error(`[world] chunk ${key} request failed`, e);
      this.empty.add(key);
    });
  }

  /** Active (finest) level for this camera distance, with hysteresis. */
  private switchLevel(dist: number) {
    const target = levelForDistance(dist);
    if (target === this.active) return;
    const edge = GRID.levels[Math.min(target, this.active)].minDist;
    if (Math.abs(dist - edge) < edge * GRID.hysteresis) return;
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
    let hexes = 0, chunks = 0;
    for (const [level, keys] of this.visibleKeys) {
      const st = this.levels[level];
      for (const key of keys) {
        const c = st.chunks.get(key);
        if (c) { hexes += c.data.count; chunks++; }
      }
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
