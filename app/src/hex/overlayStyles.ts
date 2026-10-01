/**
 * ─── OVERLAY REGISTRY ─────────────────────────────────────────────────────
 * Real-world features from OSM: rivers, roads and rail (turned into hex nodes),
 * buildings and hand-modelled landmarks.
 * Restyle or change when something appears by editing these tables.
 */
import { LineKind } from "../geo/lineKinds";

/**
 * Rivers, roads and rail are NODES: every hex they pass through becomes a River /
 * Road / Rail hex. To stay realistic, a feature only becomes nodes at a zoom level
 * where its real width is a meaningful fraction of the hex — otherwise a 30 m road
 * would show as a 1 km band. The finest level always shows everything.
 */
export interface LineStyle {
  label: string;
  /** Typical real width in km when OSM has no width tag. */
  widthKm: number;
}

export const LINE_STYLES: Record<LineKind, LineStyle> = {
  [LineKind.RiverMajor]: { label: "Major river", widthKm: 0.09 },
  [LineKind.River]: { label: "River", widthKm: 0.03 },
  [LineKind.Highway]: { label: "Highway", widthKm: 0.045 },
  [LineKind.Primary]: { label: "Primary road", widthKm: 0.025 },
  [LineKind.Secondary]: { label: "Secondary road", widthKm: 0.018 },
  [LineKind.Rail]: { label: "Railway", widthKm: 0.015 },
  [LineKind.Bridge]: { label: "Bridge", widthKm: 0.025 },
};

/** A feature becomes nodes when realWidth ≥ this × hex width (flat-to-flat). */
export const NODE_MIN_WIDTH_FRACTION = 0.25;

export function lineWidthKm(kind: LineKind, osmWidthKm: number): number {
  return osmWidthKm > 0 ? osmWidthKm : LINE_STYLES[kind].widthKm;
}

/** Does a feature this wide become nodes on a grid with this hex size? */
export function showsAsNodes(widthKm: number, hexSizeKm: number, finestLevel: boolean): boolean {
  return finestLevel || widthKm >= hexSizeKm * Math.sqrt(3) * NODE_MIN_WIDTH_FRACTION;
}

// ─── Buildings ─────────────────────────────────────────────────────────────
/** Geometry used for a building. OSM buildings get block/tower by height; landmarks pick their own. */
export type BuildingKind = "block" | "tower" | "needle" | "dome" | "saddle" | "pyramids";
export const BUILDING_KINDS: BuildingKind[] = ["block", "tower", "needle", "dome", "saddle", "pyramids"];

/** Buildings at least this tall (m) use the banded "tower" model. */
export const TOWER_MIN_HEIGHT = 60;
/** Brightness of buildings relative to their hex's prop colour. */
export const BUILDING_BRIGHTNESS = 0.9;
/** Footprints come from axis-aligned OSM bounds (overestimates rotated buildings). */
export const FOOTPRINT_SCALE = 0.75;

export interface Landmark {
  name: string;
  lat: number;
  lng: number;
  kind: BuildingKind;
  heightM: number;
  /** Footprint edge in km (visual). */
  sizeKm: number;
}
