/**
 * ─── NODE REGISTRY ─────────────────────────────────────────────────────────
 * The single place that defines how every hex node looks and behaves.
 *
 *  • NODE_TYPES    — one entry per land class (what the ground IS)
 *  • NODE_STATUSES — hazard state layered on top (what is HAPPENING there)
 *
 * The renderer turns these into per-instance colours, surface patterns and
 * 3D props. Add a type: add a LandClass value + an entry here. Restyle: edit
 * the entry. No shader or renderer changes needed.
 */
import { LandClass } from "../geo/landClass";

/** Surface pattern drawn on the top face (in-shader, zero geometry cost). */
export const Pattern = { None: 0, Stripes: 1, Dots: 2, Waves: 3, Grid: 4, Ice: 5 } as const;
export type Pattern = (typeof Pattern)[keyof typeof Pattern];

/** 3D prop placed on the top face (instanced line geometry, fine levels only). */
export type PropKind = "tree" | "pine" | "house" | "tower" | "rock";

/** Region families — borders are only drawn between different families. */
export type Family = "none" | "open" | "forest" | "water" | "settlement" | "alpine" | "ice" | "tundra" | "road" | "rail";

export interface NodeType {
  id: LandClass;
  key: string;
  label: string;
  /** Outline colour (hex). */
  line: string;
  /** Fill strength 0..1 — how much of `line` tints the face. Higher reads as filled land cover. */
  fill: number;
  /** Brightness multiplier (default 0.45). Keep ordinary land dim so hazards stand out. */
  emphasis?: number;
  pattern: Pattern;
  props?: { kind: PropKind; count: [min: number, max: number]; scale: number }[];
  /** 0..1 how readily it burns — multiplies weather risk. */
  fuel: number;
  /** Types in the same family merge into one outlined region (no border between them). */
  family: Family;
  /** Flatten to a fixed elevation (water). */
  flat?: boolean;
}

export const NODE_TYPES: Record<LandClass, NodeType> = {
  [LandClass.None]: { id: LandClass.None, key: "none", label: "Out of bounds", line: "#d7ddd6", fill: 0, pattern: Pattern.None, fuel: 0, family: "none" },
  [LandClass.Water]: { id: LandClass.Water, key: "water", label: "Lake / water", line: "#3a8ec8", fill: 0.88, emphasis: 1.05, pattern: Pattern.Waves, fuel: 0, family: "water", flat: true },
  [LandClass.Forest]: {
    id: LandClass.Forest, key: "forest", label: "Forest", line: "#2a6a28", fill: 0.82, emphasis: 0.92, pattern: Pattern.None, fuel: 1, family: "forest",
    props: [{ kind: "pine", count: [3, 6], scale: 1.15 }],
  },
  [LandClass.Shrub]: {
    id: LandClass.Shrub, key: "shrub", label: "Shrubland", line: "#5e8a32", fill: 0.72, pattern: Pattern.Dots, fuel: 0.85, family: "open",
    props: [{ kind: "tree", count: [1, 3], scale: 0.7 }],
  },
  [LandClass.Grass]: { id: LandClass.Grass, key: "grass", label: "Grassland", line: "#b4c44a", fill: 0.75, pattern: Pattern.Dots, fuel: 0.75, family: "open" },
  [LandClass.Crop]: { id: LandClass.Crop, key: "crop", label: "Cropland", line: "#d2bc4e", fill: 0.72, pattern: Pattern.Stripes, fuel: 0.4, family: "open" },
  [LandClass.Urban]: {
    id: LandClass.Urban, key: "urban", label: "Settlement", line: "#c4b8a6", fill: 0.48, emphasis: 0.6, pattern: Pattern.Grid, fuel: 0.3, family: "settlement",
    props: [{ kind: "house", count: [0, 2], scale: 0.9 }],
  },
  [LandClass.Rock]: {
    id: LandClass.Rock, key: "rock", label: "Mountain / rock", line: "#8e8478", fill: 0.78, emphasis: 0.85, pattern: Pattern.None, fuel: 0.05, family: "alpine",
    props: [{ kind: "rock", count: [1, 3], scale: 1.15 }],
  },
  // Permanent snow & ice: Arctic ice caps (Ellesmere, Devon, Baffin), Rocky Mountain glaciers.
  [LandClass.Snow]: { id: LandClass.Snow, key: "ice", label: "Ice / glacier", line: "#e4eaf0", fill: 0.7, emphasis: 0.75, pattern: Pattern.Ice, fuel: 0, family: "ice" },
  [LandClass.Wetland]: { id: LandClass.Wetland, key: "wetland", label: "Wetland", line: "#6a9a7a", fill: 0.55, pattern: Pattern.Waves, fuel: 0.35, family: "water" },
  [LandClass.River]: { id: LandClass.River, key: "river", label: "River", line: "#2f7fb4", fill: 0.9, emphasis: 1.1, pattern: Pattern.Waves, fuel: 0, family: "water" },
  [LandClass.Road]: { id: LandClass.Road, key: "road", label: "Road", line: "#8a8176", fill: 0.55, emphasis: 0.65, pattern: Pattern.None, fuel: 0.05, family: "road" },
  [LandClass.Rail]: { id: LandClass.Rail, key: "rail", label: "Railway", line: "#7a6a58", fill: 0.5, emphasis: 0.6, pattern: Pattern.Stripes, fuel: 0.05, family: "rail" },
  [LandClass.Tundra]: { id: LandClass.Tundra, key: "tundra", label: "Tundra (moss / lichen)", line: "#b3b89a", fill: 0.48, pattern: Pattern.Dots, fuel: 0.5, family: "tundra" },
};

// ─── STATUSES ──────────────────────────────────────────────────────────────
export const NodeStatus = {
  Normal: 0,
  Elevated: 1,
  High: 2,
  Extreme: 3,
  Burning: 4,
  Perimeter: 5,
  Burned: 6,
  /** Inside the projected spread of an active fire (scenario model, data/fireSpread.ts). */
  Projected: 7,
  /** An agency-reported wildfire that is under control. */
  UnderControl: 8,
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

export interface StatusStyle {
  id: NodeStatus;
  label: string;
  /** Replaces the type's outline colour when set. */
  line?: string;
  /** Face fill strength override. */
  fill?: number;
  /** Pulse amplitude 0..1 (animated in shader). */
  pulse: number;
  /** Brightness multiplier; >~1 crosses the bloom threshold and glows. */
  emphasis?: number;
  /** Extra lift in km-ish units (pops the hex up). */
  lift: number;
  /** Colour props on this hex (burning trees). */
  propColor?: string;
}

export const NODE_STATUSES: Record<NodeStatus, StatusStyle> = {
  [NodeStatus.Normal]: { id: NodeStatus.Normal, label: "Nominal", pulse: 0, lift: 0 },
  [NodeStatus.Elevated]: { id: NodeStatus.Elevated, label: "Elevated danger", line: "#ffb000", fill: 0.9, emphasis: 0.95, pulse: 0.15, lift: 0 },
  [NodeStatus.High]: { id: NodeStatus.High, label: "High danger", line: "#ff6d00", fill: 0.92, emphasis: 1.05, pulse: 0.25, lift: 0 },
  [NodeStatus.Extreme]: { id: NodeStatus.Extreme, label: "Extreme danger", line: "#ff1f1f", fill: 0.95, emphasis: 1.15, pulse: 0.3, lift: 0.06, propColor: "#ff1f1f" },
  [NodeStatus.Burning]: { id: NodeStatus.Burning, label: "Out of control", line: "#ff1744", fill: 0.98, emphasis: 1.6, pulse: 0.9, lift: 0.2, propColor: "#ff1744" },
  [NodeStatus.Perimeter]: { id: NodeStatus.Perimeter, label: "Being held", line: "#ff2fa0", fill: 0.9, emphasis: 1.3, pulse: 0.35, lift: 0.08, propColor: "#ff2fa0" },
  [NodeStatus.Burned]: { id: NodeStatus.Burned, label: "Burn scar (season)", line: "#6b4a36", fill: 0.4, emphasis: 0.75, pulse: 0, lift: 0, propColor: "#5a3a30" },
  [NodeStatus.Projected]: { id: NodeStatus.Projected, label: "Projected spread (scenario)", line: "#b44dff", fill: 0.9, emphasis: 1.15, pulse: 0.35, lift: 0.04, propColor: "#b44dff" },
  [NodeStatus.UnderControl]: { id: NodeStatus.UnderControl, label: "Under control", line: "#b0413e", fill: 0.9, emphasis: 1.0, pulse: 0.1, lift: 0.04, propColor: "#b0413e" },
};

/** Risk score (0..1) → status, when no direct fire observation applies. */
export function statusForRisk(risk: number): NodeStatus {
  if (risk >= 0.85) return NodeStatus.Extreme;
  if (risk >= 0.68) return NodeStatus.High;
  if (risk >= 0.5) return NodeStatus.Elevated;
  return NodeStatus.Normal;
}

// ─── Unfocused regions ─────────────────────────────────────────────────────
/** Regions not in focus keep all their data but render slightly greyed. */
export const UNFOCUSED_STYLE = {
  grey: "#a8aea6",
  /** 0 = original colours, 1 = fully grey. */
  desaturate: 0.45,
  /** Brightness multiplier (fires still read, just quieter). */
  emphasis: 0.75,
};

// ─── Per-node overrides ────────────────────────────────────────────────────
/** Anything set here wins over the type + status styling for one node. */
export interface NodeOverride {
  line?: string;
  fill?: number;
  status?: NodeStatus;
  pulse?: number;
  lift?: number;
  emphasis?: number;
  label?: string;
}
