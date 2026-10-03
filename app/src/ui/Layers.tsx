/** Layer toggles + legend (legend is generated from the node registry). */
import { LandClass } from "../geo/landClass";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app, type Layers } from "../state/app";
import { useStore } from "../state/store";
import { Panel, Swatch, Toggle } from "./primitives";

const LAYERS: { key: keyof Layers; label: string; color?: string; hint: string; demoOnly?: boolean }[] = [
  { key: "risk", label: "Fire risk", color: "var(--color-risk-high)", hint: "Canadian FWI System fire danger × fuel load, raised near fires (see METHODOLOGY.md)" },
  { key: "fires", label: "Fires + perimeters", color: "var(--color-fire)", hint: "CWFIS satellite hotspots + M3 perimeters" },
  { key: "spread", label: "Projected spread", color: "#6b3d8a", hint: "Scenario: FBP rates of spread grown over the real fuel map (wind, slope, rain), calibrated per fire from its own growth history. Not an official forecast." },
  { key: "air", label: "Air quality (smoke)", color: "#6b5a4a", hint: "Haze on fire-possible areas and a community smoke advisory from fire proximity, wind and intensity. Estimate only — not an official AQHI reading." },
  { key: "traffic", label: "Traffic corridors", color: "#b8791f", hint: "Highways with a fire near them, with the traffic each stretch is expected to carry that day, from measured provincial counts. Zoom to street level to see the vehicles themselves; in the demo scenario they also carry the evacuation and stop at closures (see METHODOLOGY.md). Provinces that publish no counts are skipped." },
  { key: "beacons", label: "Hotspot beacons", color: "var(--color-fire)", hint: "Vertical markers visible from any zoom" },
  { key: "wind", label: "Wind", color: "var(--color-water)", hint: "Animated streamlines: live wind today, forecast peak wind on later days (Open-Meteo)" },
  { key: "rain", label: "Rain & snow", color: "#8ec8ff", hint: "Animated rain and snow: live precipitation today, forecast daily totals on later days (snow where it is at or below freezing). Both lower fire risk and slow spread." },
  { key: "bloom", label: "Highlight glow", hint: "Bloom post-processing (off by default; turn on for night ops)" },
];

export function LayerDock({ engine }: { engine: Engine | null }) {
  const layers = useStore(app, (s) => s.layers);
  const sim = useStore(app, (s) => s.simulation);
  return (
    <Panel className="w-[220px]" title="Layers" tour="layers">
      <div className="py-1.5">
        {LAYERS.filter((l) => sim || !l.demoOnly).map((l) => (
          <Toggle key={l.key} on={layers[l.key]} label={l.label} color={l.color} hint={l.hint} onChange={(v) => engine?.setLayer(l.key, v)} />
        ))}
      </div>
      <div className="border-t border-line py-1.5">
        <Toggle on={sim} label="Demo scenario" color="var(--color-risk-high)" hint="Simulated ignitions, a heatwave and a rainstorm drifting with the wind. Clearly flagged." onChange={(v) => engine?.setSimulation(v)} />
      </div>
    </Panel>
  );
}

const LEGEND_STATUSES = [NodeStatus.Elevated, NodeStatus.High, NodeStatus.Extreme, NodeStatus.Burning, NodeStatus.Perimeter, NodeStatus.Projected, NodeStatus.Burned];
/** Every land type, so it's always clear what a hex is (incl. northern ones: tundra, ice). */
const LEGEND_TYPES = [
  LandClass.Forest, LandClass.Shrub, LandClass.Grass, LandClass.Crop, LandClass.Urban, LandClass.Wetland,
  LandClass.Water, LandClass.River, LandClass.Tundra, LandClass.Rock, LandClass.Snow, LandClass.Road, LandClass.Rail,
];

export function Legend() {
  return (
    <Panel className="w-[220px]" title="Legend" tour="legend">
      <div className="scroll-thin max-h-[min(200px,28vh)] overflow-y-auto">
      <div className="grid grid-cols-1 gap-y-1 px-3 py-2">
        {LEGEND_STATUSES.map((s) => (
          <div key={s} className="flex items-center gap-2 text-[10.5px] text-ink-dim">
            <Swatch color={NODE_STATUSES[s].line ?? "#888"} fill={`${NODE_STATUSES[s].line}99`} />
            {NODE_STATUSES[s].label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 border-t border-line px-3 py-2">
        {LEGEND_TYPES.map((t) => (
          <div key={t} className="flex items-center gap-2 text-[10.5px] text-ink-mute">
            <Swatch color={NODE_TYPES[t].line} />
            {NODE_TYPES[t].label}
          </div>
        ))}
      </div>
      </div>
    </Panel>
  );
}
