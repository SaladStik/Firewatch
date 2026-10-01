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
export const Pattern = { None: 0, Stripes: 1, Dots: 2, Waves: 3, Grid: 4 } as const;
export type Pattern = (typeof Pattern)[keyof typeof Pattern];

/** 3D prop placed on the top face (instanced line geometry, fine levels only). */
export type PropKind = "tree" | "pine" | "house" | "tower" | "rock";

/** Region families — borders are only drawn between different families. */
export type Family = "none" | "open" | "forest" | "water" | "settlement" | "alpine" | "road" | "rail";

export interface NodeType {
  id: LandClass;
  key: string;
  label: string;
  /** Outline colour (hex). */
  line: string;
  /** Fill strength 0..1 — how much of `line` bleeds into the face. Keep low for the outlined look. */
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
  [LandClass.None]: { id: LandClass.None, key: "none", label: "Out of bounds", line: "#0b2a1a", fill: 0, pattern: Pattern.None, fuel: 0, family: "none" },
  [LandClass.Water]: { id: LandClass.Water, key: "water", label: "Water", line: "#1ec8d8", fill: 0.14, emphasis: 0.8, pattern: Pattern.Waves, fuel: 0, family: "water", flat: true },
  [LandClass.Forest]: {
    id: LandClass.Forest, key: "forest", label: "Forest", line: "#2bea7c", fill: 0.07, pattern: Pattern.None, fuel: 1, family: "forest",
    props: [{ kind: "pine", count: [2, 4], scale: 1 }],
  },
  [LandClass.Shrub]: {
    id: LandClass.Shrub, key: "shrub", label: "Shrubland", line: "#6fd86a", fill: 0.06, pattern: Pattern.Dots, fuel: 0.85, family: "open",
    props: [{ kind: "tree", count: [0, 2], scale: 0.6 }],
  },
  [LandClass.Grass]: { id: LandClass.Grass, key: "grass", label: "Grassland", line: "#8fdc5a", fill: 0.05, pattern: Pattern.Dots, fuel: 0.75, family: "open" },
  [LandClass.Crop]: { id: LandClass.Crop, key: "crop", label: "Cropland", line: "#b9d85a", fill: 0.05, pattern: Pattern.Stripes, fuel: 0.4, family: "open" },
  [LandClass.Urban]: {
    id: LandClass.Urban, key: "urban", label: "Settlement", line: "#b6f7d2", fill: 0.035, emphasis: 0.5, pattern: Pattern.Grid, fuel: 0.3, family: "settlement",
    props: [{ kind: "house", count: [0, 2], scale: 0.9 }],
  },
  [LandClass.Rock]: {
    id: LandClass.Rock, key: "rock", label: "Rock / bare", line: "#7f9a8c", fill: 0.06, pattern: Pattern.None, fuel: 0.05, family: "alpine",
    props: [{ kind: "rock", count: [0, 2], scale: 1 }],
  },
  [LandClass.Snow]: { id: LandClass.Snow, key: "snow", label: "Snow / ice", line: "#cfeef5", fill: 0.05, pattern: Pattern.None, fuel: 0, family: "alpine" },
  [LandClass.Wetland]: { id: LandClass.Wetland, key: "wetland", label: "Wetland", line: "#3fcfa8", fill: 0.07, pattern: Pattern.Waves, fuel: 0.35, family: "water" },
  [LandClass.River]: { id: LandClass.River, key: "river", label: "River", line: "#1ec8d8", fill: 0.16, emphasis: 0.85, pattern: Pattern.Waves, fuel: 0, family: "water" },
  [LandClass.Road]: { id: LandClass.Road, key: "road", label: "Road", line: "#e8f0ec", fill: 0.12, emphasis: 0.8, pattern: Pattern.None, fuel: 0.05, family: "road" },
  [LandClass.Rail]: { id: LandClass.Rail, key: "rail", label: "Railway", line: "#c9a070", fill: 0.08, emphasis: 0.6, pattern: Pattern.Stripes, fuel: 0.05, family: "rail" },
  [LandClass.Tundra]: { id: LandClass.Tundra, key: "tundra", label: "Moss / lichen", line: "#9cc7a8", fill: 0.05, pattern: Pattern.Dots, fuel: 0.5, family: "open" },
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
  [NodeStatus.Elevated]: { id: NodeStatus.Elevated, label: "Elevated risk", line: "#e8d44a", fill: 0.03, emphasis: 0.6, pulse: 0, lift: 0 },
  [NodeStatus.High]: { id: NodeStatus.High, label: "High risk", line: "#ff9a1f", fill: 0.06, emphasis: 0.8, pulse: 0.15, lift: 0 },
  [NodeStatus.Extreme]: { id: NodeStatus.Extreme, label: "Extreme risk", line: "#ff6a1a", fill: 0.12, emphasis: 1.0, pulse: 0.15, lift: 0.1, propColor: "#ff9a1f" },
  [NodeStatus.Burning]: { id: NodeStatus.Burning, label: "Active fire", line: "#ff2a2a", fill: 0.5, emphasis: 2.6, pulse: 1, lift: 0.25, propColor: "#ff4a2a" },
  [NodeStatus.Perimeter]: { id: NodeStatus.Perimeter, label: "Active perimeter", line: "#ff4d2e", fill: 0.35, emphasis: 1.8, pulse: 0.5, lift: 0.1, propColor: "#ff6a3a" },
  [NodeStatus.Burned]: { id: NodeStatus.Burned, label: "Burn scar (season)", line: "#8a4a36", fill: 0.08, emphasis: 0.8, pulse: 0, lift: 0, propColor: "#5a3a30" },
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
  grey: "#8a948f",
  /** 0 = original colours, 1 = fully grey. */
  desaturate: 0.55,
  /** Brightness multiplier (fires still read, just quieter). */
  emphasis: 0.6,
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
