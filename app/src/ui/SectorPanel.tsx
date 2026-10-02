/** Details for the selected hex + actions. */
import { Crosshair, Flag, X } from "lucide-react";
import { GRID } from "../config/grid";
import { perimeterAt } from "../data/fireHistory";
import { PAST_DAYS, weatherAt } from "../data/openMeteo";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { compass, dayLabel } from "./weatherFormat";
import { HexIcon, KV, Panel, SegBar } from "./primitives";

const fx = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "–");

function riskColor(r: number) {
  return r >= 0.8 ? "var(--color-risk-ext)" : r >= 0.6 ? "var(--color-risk-high)" : r >= 0.4 ? "var(--color-risk-elev)" : "var(--color-phos)";
}

export function SectorPanel({ engine }: { engine: Engine | null }) {
  const n = useStore(app, (s) => s.selected);
  const sample = useStore(app, (s) => s.selectedSample);
  const weather = useStore(app, (s) => s.weather);
  const flagged = useStore(app, (s) => s.flagged);
  const day = useStore(app, (s) => s.forecastDay);
  const perimeters = useStore(app, (s) => s.perimeters);
  const growth = useStore(app, (s) => s.fireGrowth);
  const regionName = useStore(app, (s) => s.regions[n?.region ?? 0]?.name);
  if (!n) return null;
  const type = NODE_TYPES[n.land];
  const status = NODE_STATUSES[n.status];
  const cell = weatherAt(weather, n.lat, n.lng);
  const wx = cell?.days[day];
  const statusColor = status.line ?? type.line;
  // The fire this hex is part of, and how fast it has really been growing (data/fireHistory.ts).
  const fire = perimeterAt(perimeters.filter((p) => growth[p.id]), n.lat, n.lng);
  const fg = fire && growth[fire.id];
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
        {fire && fg && (
          <>
            <div className="mt-2 mb-1 label-xs">This fire · own growth history (CWFIS)</div>
            <KV k="Burned area" v={`${Math.round(fire.areaHa).toLocaleString()} ha`} />
            <KV k="Recent growth" v={`${fx(fg.observedKmDay, 2)} km/day (model ${fx(fg.modelKmDay, 2)})`} />
            <KV
              k="Projection scale"
              v={`×${fx(fg.k, 2)} · ${Math.round(fg.confidence * 100)}% confidence`}
              accent={fg.k > 1.3 ? "var(--color-risk-ext)" : fg.k < 0.7 ? "var(--color-phos)" : undefined}
            />
          </>
        )}
        {wx && (
          <>
            <div className="mt-2 mb-1 label-xs">Weather · Open-Meteo · {dayLabel(day, weather[0]?.dates)}</div>
            {day === 0 && cell?.now && <KV k="Live now" v={`${fx(cell.now.temp)}°C / ${fx(cell.now.rh)}% · ${fx(cell.now.wind)} km/h`} />}
            {day === 0 && cell?.now && Number.isFinite(cell.now.rain) && cell.now.rain > 0 && <KV k="Raining now" v={`${fx(cell.now.rain, 1)} mm/h`} />}
            <KV k="Max temp / min RH" v={`${fx(wx.temp)}°C / ${fx(wx.rh)}%`} />
            <KV k="Wind" v={`${fx(wx.wind)} km/h${Number.isFinite(wx.windFrom) ? ` from ${compass(wx.windFrom)} (${Math.round(wx.windFrom)}°)` : ""}`} />
            <KV k="Rain (day)" v={`${fx(wx.rainMm, 1)} mm`} />
            <KV k="Days since rain" v={wx.daysSinceRain > PAST_DAYS ? `${PAST_DAYS}+` : String(wx.daysSinceRain)} />
            <KV k="Fire danger (FWI)" v={`${fx(wx.fwi, 1)} · ${wx.danger}`} accent={wx.fwi >= 20 ? "var(--color-risk-ext)" : wx.fwi >= 10 ? "var(--color-risk-high)" : undefined} />
            <KV k="FFMC / DMC / DC" v={`${fx(wx.ffmc, 1)} / ${fx(wx.dmc, 1)} / ${fx(wx.dc)}`} />
            <KV k="ISI / BUI" v={`${fx(wx.isi, 1)} / ${fx(wx.bui, 1)}`} />
            <KV k="Fosberg (sensor comparison)" v={fx(wx.ffwi, 1)} />
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
