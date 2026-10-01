/** Default look + pose. Copy and tweak to make variants (see SKINS). */
import type { FireflyConfig, FireflyPalette, FireflyPose } from "./types";

export const CLASSIC: FireflyPalette = {
  body: "#ffd93b",
  bodyLight: "#fff3a6",
  bodyShade: "#f2b70f",
  wingFill: "rgba(38, 200, 235, 0.38)",
  wingEdge: "#37e3ff",
  eye: "#0b1420",
  eyeShine: "#ffffff",
  mouth: "#0b1420",
  cheek: "#ff9a6b",
  antenna: "#f5c518",
  antennaTip: "#ffe45c",
  band: "#e0a800",
  lantern: "#ffe86a",
  lanternCore: "#fffbe0",
  glow: "#ffd93b",
  alarmLantern: "#ff6a1a",
  alarmGlow: "#ff3b1f",
};

/** Alternative palettes — swap `palette` in the config. */
export const SKINS: Record<string, FireflyPalette> = {
  classic: CLASSIC,
  ember: { ...CLASSIC, body: "#ffb347", bodyLight: "#ffe0a8", bodyShade: "#e8811a", band: "#c96a0a", lantern: "#ffb066", antenna: "#ef9a2e", antennaTip: "#ffc070", glow: "#ff9a3b" },
  matrix: { ...CLASSIC, body: "#7dffb4", bodyLight: "#d6ffe6", bodyShade: "#2bd37a", band: "#1d9d5a", lantern: "#b8ffd6", lanternCore: "#f0fff6", antenna: "#2eea7c", antennaTip: "#a8ffcf", glow: "#2eea7c", wingFill: "rgba(46, 234, 124, 0.25)", wingEdge: "#7dffb4" },
  night: { ...CLASSIC, body: "#c9d6ff", bodyLight: "#f2f5ff", bodyShade: "#8d9ee8", band: "#6b7cd1", lantern: "#e6ecff", antenna: "#a9b8ff", antennaTip: "#e0e6ff", glow: "#9fb2ff", wingFill: "rgba(170, 140, 255, 0.3)", wingEdge: "#c3a6ff" },
};

export const DEFAULT_CONFIG: FireflyConfig = {
  palette: CLASSIC,
  bodyRadius: 34,
  wingUpper: { length: 1.85, width: 1.12, angle: -12, hinge: [0.72, -0.1] },
  wingLower: { length: 1.25, width: 0.7, angle: 28, hinge: [0.6, 0.32] },
  antennaLength: 1.25,
  antennaSpread: 24,
  eyeSize: 0.19,
  eyeSpacing: 0.42,
  eyeY: -0.04,
  lanternSize: 0.46,
  glow: 3,
};

export const REST_WING = { lift: 0, open: 1 };

export const DEFAULT_POSE: FireflyPose = {
  x: 0, y: 0, hover: 0, rotation: 0, scale: 1, squash: 0,
  wings: { upperL: { ...REST_WING }, upperR: { ...REST_WING }, lowerL: { ...REST_WING }, lowerR: { ...REST_WING } },
  antennaL: 0, antennaR: 0,
  eyeOpenL: 1, eyeOpenR: 1, lookX: 0, lookY: 0,
  smile: 0.6, mouthOpen: 0, brow: 0, browAmount: 0, blush: 0.25,
  lantern: 1, alarm: 0,
};

export function makeConfig(patch: Partial<FireflyConfig> = {}): FireflyConfig {
  return { ...DEFAULT_CONFIG, ...patch, palette: { ...DEFAULT_CONFIG.palette, ...(patch.palette ?? {}) } };
}
