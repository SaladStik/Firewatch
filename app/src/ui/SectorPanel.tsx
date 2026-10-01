/** Details for the selected hex + actions. */
import { Crosshair, Flag, X } from "lucide-react";
import { GRID } from "../config/grid";
import { weatherAt } from "../data/openMeteo";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { HexIcon, KV, Panel, SegBar } from "./primitives";

function riskColor(r: number) {
  return r >= 0.8 ? "var(--color-risk-ext)" : r >= 0.6 ? "var(--color-risk-high)" : r >= 0.4 ? "var(--color-risk-elev)" : "var(--color-phos)";
}

export function SectorPanel({ engine }: { engine: Engine | null }) {
  const n = useStore(app, (s) => s.selected);
  const sample = useStore(app, (s) => s.selectedSample);
  const weather = useStore(app, (s) => s.weather);
  const flagged = useStore(app, (s) => s.flagged);
  const regionName = useStore(app, (s) => s.regions[n?.region ?? 0]?.name);
  if (!n) return null;
  const type = NODE_TYPES[n.land];
  const status = NODE_STATUSES[n.status];
  const wx = weatherAt(weather, n.lat, n.lng);
  const statusColor = status.line ?? type.line;
  const isFlagged = flagged.includes(n.key);
  const cellM = GRID.levels[n.level].size * Math.sqrt(3) * 1000;

  return (
    <Panel
      className="w-[280px]"
      tour="sector"
      title={`Sector ${n.q},${n.r}`}
      right={
        <button onClick={() => engine?.scene.select(null)} className="text-ink-mute hover:text-phos" aria-label="Close">
          <X size={13} />
        </button>
      }
    >
      <div className="flex items-center gap-3 px-3 pt-3">
        <HexIcon size={40} color={statusColor} fill={`${statusColor}22`} />
        <div className="min-w-0">
          <div className="text-[13px] font-bold tracking-[0.12em]" style={{ color: statusColor }}>
            {n.status === NodeStatus.Normal ? "NOMINAL" : status.label.toUpperCase()}
          </div>
          <div className="text-[11px] text-ink-dim">{type.label} · LOD {n.level} · {cellM >= 1000 ? `${(cellM / 1000).toFixed(1)} km` : `${Math.round(cellM)} m`} cell</div>
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="mb-1 flex justify-between text-[10px] tracking-widest">
          <span className="text-ink-mute">RISK INDEX</span>
          <span style={{ color: riskColor(n.risk) }}>{Math.round(n.risk * 100)}</span>
        </div>
        <SegBar value={n.risk} color={riskColor(n.risk)} />
      </div>

      <div className="px-3 py-2.5">
        <KV k="Region" v={regionName} />
        <KV k="Position" v={`${n.lat.toFixed(3)}°, ${n.lng.toFixed(3)}°`} />
        <KV k="Elevation" v={`${Math.round(n.elevation)} m`} />
        <KV k="Fuel load" v={`${Math.round(type.fuel * 100)}%`} />
        <KV
          k="Nearest hotspot"
          v={sample ? (Number.isFinite(sample.nearestHotspotKm) ? `${sample.nearestHotspotKm.toFixed(1)} km` : "> 500 km") : "…"}
          accent={sample && sample.nearestHotspotKm < 30 ? "var(--color-risk-high)" : undefined}
        />
        {wx && (
          <>
            <div className="mt-2 mb-1 label-xs">Weather · Open-Meteo</div>
            <KV k="Temp / RH" v={`${wx.temp.toFixed(0)}°C / ${wx.rh.toFixed(0)}%`} />
            <KV k="Wind" v={`${wx.wind.toFixed(0)} km/h`} />
            <KV k="Rain (72h)" v={`${wx.rain3d.toFixed(1)} mm`} />
          </>
        )}
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <button
          onClick={() => engine?.scene.flyTo(n.x, n.z, Math.min(engine.scene.distance, 20))}
          className="flex flex-1 items-center justify-center gap-1.5 border border-line py-1.5 text-[10.5px] tracking-widest text-ink-dim transition hover:border-phos hover:text-phos-glow"
        >
          <Crosshair size={12} /> FOCUS
        </button>
        <button
          disabled={isFlagged}
          onClick={() => engine?.flag(n)}
          className="flex flex-1 items-center justify-center gap-1.5 border py-1.5 text-[10.5px] tracking-widest transition enabled:hover:shadow-[0_0_12px_rgba(125,211,255,.35)] disabled:opacity-50"
          style={{ borderColor: "#7dd3ff66", color: "#7dd3ff" }}
        >
          <Flag size={12} /> {isFlagged ? "FLAGGED" : "FLAG PATROL"}
        </button>
      </div>
    </Panel>
  );
}
