/**
 * Data contracts between the main thread, the world worker and the renderer.
 * Everything that crosses the worker boundary is plain data / typed arrays.
 */
import type { GrowthField, GrowthSource } from "./fireGrowth";
import type { RainBlob } from "../data/rain";
import type { LandClass } from "../geo/landClass";
import type { NodeStatus } from "../hex/nodeTypes";
import type { Landmark } from "../hex/overlayStyles";
import type { ProjectionParams } from "../geo/projection";

/** Raw hex data for one chunk, struct-of-arrays (one entry per hex). */
export interface ChunkData {
  level: number;
  cx: number;
  cz: number;
  count: number;
  q: Int32Array;
  r: Int32Array;
  x: Float32Array;
  z: Float32Array;
  /** Surface elevation in metres (terraced, water flattened). */
  elev: Float32Array;
  land: Uint8Array; // LandClass
  status: Uint8Array; // NodeStatus
  risk: Float32Array; // 0..1
  /** 6-bit mask: bit k = neighbour across edge k (normal at 60°·k) is a different region. */
  edges: Uint8Array;
  /** 6-bit mask: bit k = neighbour across edge k is at least one terrace lower (draw a contour). */
  contours: Uint8Array;
  /** Workspace index of the region (province) each hex belongs to. */
  region: Uint8Array;
  /** Buildings, BLD_STRIDE floats each: x, z, wKm, dKm, hKm, kindIndex, hexIndex. */
  buildings: Float32Array;
  /** Dense (col,row) → instance index lookup for O(1) picking; -1 = empty. */
  cellIndex: Int32Array;
}

/** Hazard data after projection into world km. Sent to the worker. */
export interface HazardSnapshot {
  /** dx/dz/stretch: the day's downwind direction at the hotspot (see world/spread.ts). */
  hotspots: { x: number; z: number; frp: number; fwi: number; dx: number; dz: number; stretch: number; scale: number }[];
  /** Out-of-control fires (agency-reported, plus simulated ones in the demo): centre and radius in km. */
  burning: { x: number; z: number; r: number }[];
  perimeters: { active: boolean; minX: number; maxX: number; minZ: number; maxZ: number; rings: number[][] }[];
  /** Regular lat/lng grids of weather risk (0..1), one per region. */
  weather: { lat0: number; lng0: number; step: number; nLat: number; nLng: number; risk: number[] }[];
  /** Projected fire spread ellipses for the selected day (empty when the layer is off). */
  spread: GrowthField | null;
  /** Demo-scenario rain cells (real rain is already in the weather risk grid). */
  rain: RainBlob[];
}

export interface TerrainMeta {
  width: number;
  height: number;
  pxKm: number;
  minX: number;
  minZ: number;
  elevMin: number;
  elevMax: number;
  border: number[][][];
}

/** Everything the UI needs to know about one hex. */
export interface HexNodeInfo {
  level: number;
  q: number;
  r: number;
  x: number;
  z: number;
  lat: number;
  lng: number;
  elevation: number;
  land: LandClass;
  status: NodeStatus;
  risk: number;
  key: string;
  /** Workspace index of the region (province). */
  region: number;
}

// ------------------------------------------------------------- RPC messages
export type WorkerRequest =
  | { id: number; type: "init"; projection: ProjectionParams }
  | { id: number; type: "addRegion"; url: string; index: number; landmarks: Landmark[] }
  | { id: number; type: "chunk"; level: number; cx: number; cz: number }
  | { id: number; type: "restatus"; level: number; cx: number; cz: number }
  | { id: number; type: "hazards"; hazards: HazardSnapshot }
  | { id: number; type: "growth"; sources: GrowthSource[]; horizon: number; size: number }
  | { id: number; type: "sample"; x: number; z: number }
  | { id: number; type: "riskScan"; x0: number; z0: number; step: number; nx: number; nz: number };

/** Map risk (0..1) on an nx × nz grid of world points, row-major from (x0, z0) — same evaluation as the hexes. */
export interface RiskScan { risk: Float32Array; status: Uint8Array }

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
