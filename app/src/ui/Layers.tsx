/** Layer toggles + legend (legend is generated from the node registry). */
import { LandClass } from "../geo/landClass";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app, type Layers } from "../state/app";
import { useStore } from "../state/store";
import { HexIcon, Panel, Toggle } from "./primitives";

const LAYERS: { key: keyof Layers; label: string; color?: string; hint: string }[] = [
  { key: "risk", label: "Fire risk", color: "var(--color-risk-high)", hint: "Fosberg FFWI × dryness × fuel, stretched downwind of fires" },
  { key: "fires", label: "Fires + perimeters", color: "var(--color-fire)", hint: "CWFIS satellite hotspots + M3 perimeters" },
  { key: "spread", label: "Projected spread", color: "#c084fc", hint: "Scenario: where active fires could reach by the selected day (wind + Fosberg). Not an official forecast." },
  { key: "beacons", label: "Hotspot beacons", color: "var(--color-fire)", hint: "Vertical markers visible from any zoom" },
  { key: "wind", label: "Wind", color: "var(--color-water)", hint: "Animated streamlines: wind direction + speed for the selected day" },
  { key: "bloom", label: "Glow", hint: "Bloom post-processing (turn off on slow devices)" },
];

export function LayerDock({ engine }: { engine: Engine | null }) {
  const layers = useStore(app, (s) => s.layers);
  const sim = useStore(app, (s) => s.simulation);
  return (
    <Panel className="w-[220px]" title="Layers" tour="layers">
      <div className="py-1.5">
        {LAYERS.map((l) => (
          <Toggle key={l.key} on={layers[l.key]} label={l.label} color={l.color} hint={l.hint} onChange={(v) => engine?.setLayer(l.key, v)} />
        ))}
      </div>
      <div className="border-t border-line py-1.5">
        <Toggle on={sim} label="Demo scenario" color="var(--color-risk-high)" hint="Adds simulated ignitions + a heatwave. Clearly flagged." onChange={(v) => engine?.setSimulation(v)} />
      </div>
    </Panel>
  );
}

const LEGEND_STATUSES = [NodeStatus.Elevated, NodeStatus.High, NodeStatus.Extreme, NodeStatus.Burning, NodeStatus.Perimeter, NodeStatus.Projected, NodeStatus.Burned];
const LEGEND_TYPES = [LandClass.Forest, LandClass.Grass, LandClass.Crop, LandClass.Urban, LandClass.Water, LandClass.River, LandClass.Road, LandClass.Rail, LandClass.Wetland, LandClass.Rock, LandClass.Snow];

export function Legend() {
  return (
    <Panel className="w-[220px]" title="Legend" tour="legend">
      <div className="grid grid-cols-1 gap-y-1 px-3 py-2">
        {LEGEND_STATUSES.map((s) => (
          <div key={s} className="flex items-center gap-2 text-[10.5px] text-ink-dim">
            <HexIcon size={12} color={NODE_STATUSES[s].line} fill={`${NODE_STATUSES[s].line}33`} />
            {NODE_STATUSES[s].label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 border-t border-line px-3 py-2">
        {LEGEND_TYPES.map((t) => (
          <div key={t} className="flex items-center gap-2 text-[10.5px] text-ink-mute">
            <HexIcon size={11} color={NODE_TYPES[t].line} />
            {NODE_TYPES[t].label}
          </div>
        ))}
      </div>
    </Panel>
  );
}
