/**
 * Land classes baked into the terrain raster (blue channel).
 * Values are stored in data files — append new classes, never renumber.
 * How each class LOOKS lives in `hex/nodeTypes.ts`.
 */
export const LandClass = {
  None: 0,
  Water: 1,
  Forest: 2,
  Shrub: 3,
  Grass: 4,
  Crop: 5,
  Urban: 6,
  Rock: 7,
  Snow: 8,
  Wetland: 9,
  Tundra: 10,
  // Linear features promoted to nodes (from OSM, not the land-cover raster):
  River: 11,
  Road: 12,
  Rail: 13,
} as const;
export type LandClass = (typeof LandClass)[keyof typeof LandClass];
