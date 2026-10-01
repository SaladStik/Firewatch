/**
 * Level-of-detail configuration for the hex world.
 *
 * Each level is an independent hex grid. The camera's distance to its target
 * picks the active level; only chunks near the focus point are built.
 * Tune freely — nothing else hardcodes these numbers.
 */
export interface GridLevel {
  /** Hex circumradius in km. */
  size: number;
  /** Active while camera distance (km) is >= minDist. Levels are ordered coarse → fine. */
  minDist: number;
  /** Elevation terrace step in metres (0 = smooth). */
  terrace: number;
  /** Land class = majority vote of 7 samples (better for big hexes). */
  majorityLandClass: boolean;
  /** Build 3D props (trees, houses). */
  decorations: boolean;
  /** OSM buildings at least this tall (m) are drawn (Infinity = none). Landmarks follow `landmarks`. */
  buildingMinHeight: number;
  landmarks: boolean;
}

export const GRID = {
  /** Cells per chunk edge (chunk = N×N hexes). */
  chunkCells: 24,
  /** Visual gap between hexes (1 = touching). */
  hexScale: 0.965,
  /** Visible radius around the focus point = camera distance × this. */
  viewRadiusFactor: 1.45,
  /** Hard cap on visible radius, in hexes of the current level. */
  maxRadiusHexes: 120,
  /** Max chunk builds requested per frame (keeps the main thread smooth). */
  maxChunkRequestsPerFrame: 6,
  /** Chunks kept in memory per level after leaving view (LRU). */
  cacheChunks: 400,
  levels: [
    { size: 7.0, minDist: 330, terrace: 150, majorityLandClass: true, decorations: false, buildingMinHeight: Infinity, landmarks: false },
    { size: 2.2, minDist: 105, terrace: 100, majorityLandClass: true, decorations: false, buildingMinHeight: Infinity, landmarks: false },
    { size: 0.7, minDist: 32, terrace: 50, majorityLandClass: false, decorations: false, buildingMinHeight: 80, landmarks: true },
    { size: 0.22, minDist: 11, terrace: 20, majorityLandClass: false, decorations: true, buildingMinHeight: 12, landmarks: true },
    { size: 0.075, minDist: 0, terrace: 10, majorityLandClass: false, decorations: true, buildingMinHeight: 12, landmarks: true },
  ] satisfies GridLevel[],
};

export function levelForDistance(dist: number): number {
  const lv = GRID.levels.findIndex((l) => dist >= l.minDist);
  return lv === -1 ? GRID.levels.length - 1 : lv;
}

/** Vertical exaggeration as a smooth function of camera distance. */
export function verticalScale(dist: number): number {
  // log-lerp between close-up (x3) and province view (x28)
  const t = Math.min(1, Math.max(0, Math.log(dist / 6) / Math.log(1600 / 6)));
  return 3 + t * t * 25;
}

/** Elevations below this (m) sit at y=0 (lowest point in Alberta is ~150 m). */
export const BASE_ELEVATION_M = 150;
