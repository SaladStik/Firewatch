/** Promise-based RPC wrapper around world.worker.ts. */
import type { Landmark } from "../hex/overlayStyles";
import type { ProjectionParams } from "../geo/projection";
import type { ChunkData, HazardSnapshot, TerrainMeta, WorkerRequest, WorkerResponse } from "./types";
import type { GrowthField, GrowthSource } from "./fireGrowth";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface PointSample {
  elevation: number;
  land: number;
  /** Workspace index of the region at this point, or -1. */
  region: number;
  weatherRisk: number;
  nearestHotspotKm: number;
}

/**
 * A small pool of world workers. Every worker holds the same data (regions, hazards);
 * chunk builds are spread across them so street-level chunks (with detail roads and
 * streams) build in parallel. Queries that need one answer go to worker 0.
 */
export class WorldClient {
  /** Workers in the pool: leave a core for the main thread; cap memory (each holds every raster). */
  readonly size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
  private workers: Worker[] = [];
  private load: number[] = [];
  private seq = 0;
  private pending = new Map<number, Pending & { w: number }>();

  constructor() {
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL("./world.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        this.load[p.w]--;
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(new Error(ev.data.error));
      };
      this.workers.push(w);
      this.load.push(0);
    }
  }

  private send<T>(w: number, msg: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    this.load[w]++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, w });
      this.workers[w].postMessage({ ...msg, id }, transfer);
    });
  }
  /** One worker (first one). */
  private call<T>(msg: DistributiveOmit<WorkerRequest, "id">): Promise<T> {
    return this.send<T>(0, msg);
  }
  /** The least busy worker. */
  private any<T>(msg: DistributiveOmit<WorkerRequest, "id">): Promise<T> {
    let w = 0;
    for (let i = 1; i < this.size; i++) if (this.load[i] < this.load[w]) w = i;
    return this.send<T>(w, msg);
  }
  /** Every worker (state updates); resolves with worker 0's answer. */
  private all<T>(msg: DistributiveOmit<WorkerRequest, "id">): Promise<T> {
    return Promise.all(this.workers.map((_, i) => this.send<T>(i, msg))).then((r) => r[0]);
  }

  /** Shared projection (must match the bake). */
  init(projection: ProjectionParams) {
    return this.all<boolean>({ type: "init", projection });
  }
  /** Load one region's baked data (folder with terrain.{png,json}, osm.json). */
  addRegion(dataUrl: string, index: number, landmarks: Landmark[] = []) {
    return this.all<TerrainMeta>({ type: "addRegion", url: dataUrl, index, landmarks });
  }
  chunk(level: number, cx: number, cz: number) {
    return this.any<ChunkData | null>({ type: "chunk", level, cx, cz });
  }
  setHazards(hazards: HazardSnapshot) {
    return this.all<boolean>({ type: "hazards", hazards });
  }
  restatus(c: ChunkData) {
    return this.any<{ status: Uint8Array; risk: Float32Array; edges: Uint8Array } | null>({ type: "restatus", level: c.level, cx: c.cx, cz: c.cz });
  }
  /** Run the fuel-aware fire growth model on one worker (it needs the land cover). */
  growth(sources: GrowthSource[], horizon: number, size: number) {
    return this.any<GrowthField>({ type: "growth", sources, horizon, size });
  }

  sample(x: number, z: number) {
    return this.call<PointSample>({ type: "sample", x, z });
  }
  /** Nearest open water at least ~1.2 km across (a lake a skimmer can scoop), within maxKm; null if none. */
  water(x: number, z: number, maxKm: number) {
    return this.call<{ x: number; z: number; km: number } | null>({ type: "water", x, z, maxKm });
  }
  dispose() {
    for (const w of this.workers) w.terminate();
  }
}
