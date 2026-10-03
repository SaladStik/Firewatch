/**
 * How the firefly looks on the map. Produced by the preview page's "copy config"
 * (`/firefly.html`, src/mascot/preview/main.tsx), so re-tune him there and paste the result
 * over this. The mascot module keeps its own CLASSIC look as the default; this is the one the
 * app applies (src/firefly/mascot.ts).
 */
import { makeConfig } from "./mascot/firefly";

export const FIREFLY_CONFIG = makeConfig({
  "palette": {
    "body": "#ffb347",
    "bodyLight": "#ffe0a8",
    "bodyShade": "#e8811a",
    "wingFill": "rgba(38, 200, 235, 0.36)",
    "wingEdge": "#37e3ff",
    "eye": "#0b1420",
    "eyeShine": "#ffffff",
    "mouth": "#0b1420",
    "cheek": "#ff9a6b",
    "antenna": "#ef9a2e",
    "antennaTip": "#ffc070",
    "band": "#c96a0a",
    "lantern": "#ffb066",
    "lanternCore": "#fffbe0",
    "glow": "#ff9a3b",
    "alarmLantern": "#ff6a1a",
    "alarmGlow": "#ff3b1f"
  },
  "bodyRadius": 34,
  "wingUpper": {
    "length": 1.11,
    "width": 0.672,
    "angle": -12,
    "hinge": [
      0.72,
      -0.1
    ]
  },
  "wingLower": {
    "length": 0.75,
    "width": 0.42,
    "angle": 28,
    "hinge": [
      0.6,
      0.32
    ]
  },
  "antennaLength": 1.25,
  "antennaSpread": 24,
  "eyeSize": 0.19,
  "eyeSpacing": 0.42,
  "eyeY": -0.04,
  "lanternSize": 0.46,
  "glow": 3
});
