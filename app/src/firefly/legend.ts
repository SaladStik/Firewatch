/**
 * What Firefly knows about the map's legend and layers, sent as background context when a
 * conversation starts. Built from the same lists the Legend and Layers panels show.
 */
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import { LAYERS, LEGEND_STATUSES, LEGEND_TYPES } from "../ui/legendData";

/** How each status looks on the map (the registry only has hex colours). */
const STATUS_LOOK: Partial<Record<NodeStatus, string>> = {
  [NodeStatus.Elevated]: "amber hexes, risk index 50 to 67",
  [NodeStatus.High]: "orange hexes, risk index 68 to 84",
  [NodeStatus.Extreme]: "red hexes, risk index 85 and up",
  [NodeStatus.Burning]: "bright red raised, pulsing hexes with burning trees: a satellite hotspot in the hex right now",
  [NodeStatus.Perimeter]: "pink raised hexes: inside an active mapped fire perimeter",
  [NodeStatus.Projected]: "violet hexes: where an active fire could reach by the selected forecast day (scenario, not a forecast)",
  [NodeStatus.Burned]: "dark brown hexes: burned earlier this season",
};

export function legendContext(): string {
  const statuses = LEGEND_STATUSES.map((s) => `${NODE_STATUSES[s].label}: ${STATUS_LOOK[s] ?? ""}`).join("; ");
  const land = LEGEND_TYPES.map((t) => `${NODE_TYPES[t].label} (fuel ${Math.round(NODE_TYPES[t].fuel * 100)}%)`).join(", ");
  const layers = LAYERS.map((l) => `${l.label}: ${l.hint}`).join(" | ");
  return [
    "Map legend (use this when the user asks about the legend, colours or layers).",
    `The map is hexagons. Each hex is coloured by its land cover unless a danger or fire status overrides it. Statuses: ${statuses}.`,
    "Risk index = the day's fire danger (Canadian FWI System) times the land cover's fuel load, raised near fires in the wind's direction. Water, rock and roads have little or no fuel, so they stay low.",
    `Land covers and their fuel load: ${land}.`,
    `Layers (toggled in the Layers panel): ${layers}.`,
    "Hotspot beacons are tall markers over satellite hotspots, not monitoring stations. Demo scenario adds clearly labelled simulated fires, a heatwave and a rainstorm.",
  ].join("\n");
}
