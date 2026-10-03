/** What the Layers panel and the Legend list (shared with Firefly, who explains them). */
import { LandClass } from "../geo/landClass";
import { NodeStatus } from "../hex/nodeTypes";
import type { Layers } from "../state/app";

export const LAYERS: { key: keyof Layers; label: string; color?: string; hint: string; demoOnly?: boolean }[] = [
  { key: "risk", label: "Fire risk", color: "var(--color-risk-high)", hint: "Canadian FWI System fire danger × fuel load, raised near fires (see METHODOLOGY.md)" },
  { key: "fires", label: "Fires + perimeters", color: "var(--color-fire)", hint: "Agency-reported fires by stage of control (NRCan national fire list) + CWFIS M3 perimeters. Satellite hotspots are unconfirmed heat (often farm burns)" },
  { key: "spread", label: "Projected spread", color: "#6b3d8a", hint: "Scenario: FBP rates of spread grown over the real fuel map (wind, slope, rain), calibrated per fire from its own growth history. Not an official forecast." },
  { key: "air", label: "Air quality (smoke)", color: "#6b5a4a", hint: "Haze on fire-possible areas and a community smoke advisory from fire proximity, wind and intensity. Estimate only — not an official AQHI reading." },
  { key: "traffic", label: "Traffic corridors", color: "#b8791f", hint: "Highways with a fire near them, with the traffic each stretch is expected to carry that day, from measured provincial counts. Zoom to street level to see the vehicles themselves; in the demo scenario they also carry the evacuation and stop at closures (see METHODOLOGY.md). Provinces that publish no counts are skipped." },
  { key: "beacons", label: "Hotspot beacons", color: "var(--color-fire)", hint: "Unconfirmed satellite heat detections, visible from any zoom" },
  { key: "wind", label: "Wind", color: "var(--color-water)", hint: "Animated streamlines: live wind today, forecast peak wind on later days (Open-Meteo)" },
  { key: "rain", label: "Rain & snow", color: "#8ec8ff", hint: "Animated rain and snow: live precipitation today, forecast daily totals on later days (snow where it is at or below freezing). Both lower fire risk and slow spread." },
  { key: "bloom", label: "Highlight glow", hint: "Bloom post-processing (off by default; turn on for night ops)" },
];

export const LEGEND_STATUSES = [NodeStatus.Elevated, NodeStatus.High, NodeStatus.Extreme, NodeStatus.Burning, NodeStatus.Perimeter, NodeStatus.UnderControl, NodeStatus.Projected, NodeStatus.Burned];
/** Every land type, so it's always clear what a hex is (incl. northern ones: tundra, ice). */
export const LEGEND_TYPES = [
  LandClass.Forest, LandClass.Shrub, LandClass.Grass, LandClass.Crop, LandClass.Urban, LandClass.Wetland,
  LandClass.Water, LandClass.River, LandClass.Tundra, LandClass.Rock, LandClass.Snow, LandClass.Road, LandClass.Rail,
];
