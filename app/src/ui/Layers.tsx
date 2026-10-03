/** Layer toggles + legend (legend is generated from the node registry). */
import { NODE_STATUSES, NODE_TYPES } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { LAYERS, LEGEND_STATUSES, LEGEND_TYPES } from "./legendData";
import { Panel, Swatch, Toggle } from "./primitives";



export function LayerDock({ engine, dock }: { engine: Engine | null; dock?: boolean }) {
  const layers = useStore(app, (s) => s.layers);
  const sim = useStore(app, (s) => s.simulation);
  return (
    <Panel className="w-[220px]" title="Layers" tour="layers" dock={dock} collapsible={!!dock}>
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



export function Legend({ dock }: { dock?: boolean }) {
  return (
    <Panel className="flex min-h-0 w-[220px] flex-col" title="Legend" tour="legend" dock={dock} collapsible={!!dock}>
      <div>
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
