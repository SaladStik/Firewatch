/**
 * Vector line kinds baked from OSM (stored in data files — append, never renumber).
 * How each kind LOOKS and from which zoom level it shows lives in `hex/overlayStyles.ts`.
 */
export const LineKind = {
  RiverMajor: 0,
  River: 1,
  Highway: 2,
  Primary: 3,
  Secondary: 4,
  Rail: 5,
  Bridge: 6,
} as const;
export type LineKind = (typeof LineKind)[keyof typeof LineKind];
