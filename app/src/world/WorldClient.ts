/** Promise-based RPC wrapper around world.worker.ts. */
import type { Landmark } from "../hex/overlayStyles";
import type { ProjectionParams } from "../geo/projection";
import type { ChunkData, HazardSnapshot, TerrainMeta, WorkerRequest, WorkerResponse } from "./types";

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

export class WorldClient {
  private worker = new Worker(new URL("./world.worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
  }

  private call<T>(msg: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Shared projection (must match the bake). */
  init(projection: ProjectionParams) {
    return this.call<boolean>({ type: "init", projection });
  }
  /** Load one region's baked data (folder with terrain.{png,json}, osm.json). */
  addRegion(dataUrl: string, index: number, landmarks: Landmark[] = []) {
    return this.call<TerrainMeta>({ type: "addRegion", url: dataUrl, index, landmarks });
  }
  chunk(level: number, cx: number, cz: number) {
    return this.call<ChunkData | null>({ type: "chunk", level, cx, cz });
  }
  setHazards(hazards: HazardSnapshot) {
    return this.call<boolean>({ type: "hazards", hazards });
  }
  restatus(c: ChunkData) {
    return this.call<{ status: Uint8Array; risk: Float32Array; edges: Uint8Array } | null>({ type: "restatus", level: c.level, cx: c.cx, cz: c.cz });
  }
  sample(x: number, z: number) {
    return this.call<PointSample>({ type: "sample", x, z });
  }
  dispose() {
    this.worker.terminate();
  }
}
