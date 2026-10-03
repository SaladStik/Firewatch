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
  /** Hex scale (1 = touching, <1 = visible gap). Defaults to GRID.hexScale. */
  gap?: number;
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
  viewRadiusFactor: 2.6,
  /** Coarser rings drawn beyond the active level (far-distance, lower detail). */
  farRings: 2,
  /** Each far ring reaches this many times further than the ring inside it. */
  farRingReach: 3,
  /** Hard cap on visible radius, in hexes of the current level. */
  maxRadiusHexes: 300,
  /** Max chunk builds requested per frame (keeps the main thread smooth). */
  maxChunkRequestsPerFrame: 10,
  /** Chunks kept in memory per level after leaving view (LRU). */
  cacheChunks: 400,
  /** Switch level only once the camera is this fraction past a threshold (avoids flicker). */
  hysteresis: 0.03,
  levels: [
    // National view (all of Canada).
    { size: 22, minDist: 7968, gap: 1, terrace: 250, majorityLandClass: true, decorations: false, buildingMinHeight: Infinity, landmarks: false },
    { size: 7.0, minDist: 2066, gap: 1, terrace: 150, majorityLandClass: true, decorations: false, buildingMinHeight: Infinity, landmarks: false },
    { size: 2.2, minDist: 688, gap: 1, terrace: 100, majorityLandClass: true, decorations: false, buildingMinHeight: Infinity, landmarks: false },
    { size: 0.7, minDist: 229, gap: 1, terrace: 50, majorityLandClass: false, decorations: false, buildingMinHeight: 80, landmarks: true },
    { size: 0.22, minDist: 57, terrace: 20, majorityLandClass: false, decorations: true, buildingMinHeight: 12, landmarks: true },
    { size: 0.075, minDist: 13, terrace: 10, majorityLandClass: false, decorations: true, buildingMinHeight: 12, landmarks: true },
    // L6 — street level: ~38 m hexes, narrower than a city block, so the real street grid shows
    // (cities with a 20 m raster also get real parks, rivers and blocks: config/cities.ts).
    { size: 0.022, minDist: 0, terrace: 4, majorityLandClass: false, decorations: true, buildingMinHeight: 12, landmarks: true },
  ] satisfies GridLevel[],
};

export function levelForDistance(dist: number): number {
  const lv = GRID.levels.findIndex((l) => dist >= l.minDist);
  return lv === -1 ? GRID.levels.length - 1 : lv;
}

/**
 * Vertical exaggeration by camera distance (km). Tunable live with the LOD tuner (Ctrl+Shift+L).
 *   close    — exaggeration right up close
 *   province — exaggeration at `provinceDist`
 *   national — exaggeration at `nationalDist`
 *   curve    — how late the ramp kicks in (higher = stays near `close` longer)
 */
export const VSCALE = { close: 1, province: 40, national: 60, curve: 3.4, provinceDist: 1600, nationalDist: 6000 };

export function verticalScale(dist: number): number {
  const v = VSCALE;
  const t = Math.min(1, Math.max(0, Math.log(dist / 6) / Math.log(v.provinceDist / 6)));
  const n = Math.min(1, Math.max(0, Math.log(dist / v.provinceDist) / Math.log(v.nationalDist / v.provinceDist)));
  return v.close + Math.pow(t, v.curve) * (v.province - v.close) + n * (v.national - v.province);
}

/**
 * Relief curve: height ∝ (elevation above base)^RELIEF_EXPONENT. Above 1 makes high ground
 * (the Rockies, the Torngats, Ellesmere's ice caps) stand out from plateaus like the prairies,
 * instead of the whole province being lifted evenly. 1 = linear.
 */
export const RELIEF_EXPONENT = 1.3;

/** Elevations below this (m) sit at y=0 (lowest point in Alberta is ~150 m). */
export const BASE_ELEVATION_M = 150;
