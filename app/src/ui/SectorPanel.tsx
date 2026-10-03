/** Details for the selected hex + actions. */
import { fireHotspotsOf } from "../state/fires";
import { Crosshair, Flag, X } from "lucide-react";
import { GRID } from "../config/grid";
import { airAt } from "../data/airQuality";
import { perimeterAt } from "../data/fireHistory";
import { PAST_DAYS, weatherAt } from "../data/openMeteo";
import { snowShare } from "../data/rain";
import { simulatedHotspots } from "../data/hazards";
import { NODE_STATUSES, NODE_TYPES, NodeStatus } from "../hex/nodeTypes";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { COMPASS_NAMES, compass, dayLabel, sectorOf } from "./weatherFormat";
import { KV, Panel, SegBar, Swatch } from "./primitives";
import { useMemo } from "react";

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
  // Heat that counts as fire (likely farm burns left out, reported fires added): state/fires.ts.
  const hotspots = useStore(app, fireHotspotsOf);
  const spread = useStore(app, (s) => s.spread);
  const sim = useStore(app, (s) => s.simulation);
  const regions = useStore(app, (s) => s.regions);
  const region = useStore(app, (s) => s.regions[n?.region ?? 0]);
  const airLayer = useStore(app, (s) => s.layers.air);

  const air = useMemo(() => {
    if (!n || !airLayer) return null;
    const fires = sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
    return airAt(n.lat, n.lng, { hotspots: fires, perimeters, weather, day, spread, growth });
  }, [n, airLayer, hotspots, perimeters, weather, day, spread, growth, sim, regions]);

  if (!n) return null;
  const regionName = region?.name;
  const bearing = region ? sectorOf(n.lat, n.lng, region.bbox) : "N";
  const type = NODE_TYPES[n.land];
  const status = NODE_STATUSES[n.status];
  if (!type || !status) return null;
  const cell = weatherAt(weather, n.lat, n.lng);
  const wx = cell?.days[day];
  const statusColor = status.line ?? type.line;
  // The fire this hex is part of, and how fast it has really been growing (data/fireHistory.ts).
  const fire = perimeterAt(perimeters.filter((p) => growth[p.id]), n.lat, n.lng);
  const fg = fire && growth[fire.id];
  const isFlagged = flagged.includes(n.key);
  const cellM = GRID.levels[n.level].size * Math.sqrt(3) * 1000;
  const airAccent = air && air.advisory
    ? (air.level === "Extreme" || air.level === "Very High" ? "var(--color-risk-ext)" : "var(--color-risk-high)")
    : undefined;

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
        <Swatch color={statusColor} fill={`${statusColor}55`} />
        <div className="min-w-0">
          <div className="text-[13px] font-bold tracking-wide" style={{ color: statusColor }}>
            {n.status === NodeStatus.Normal ? "Nominal" : status.label}
          </div>
          <div className="text-[11px] text-ink-dim">{type.label} · {cellM >= 1000 ? `${(cellM / 1000).toFixed(1)} km` : `${Math.round(cellM)} m`} cell</div>
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
        <KV k="Map sector" v={`${COMPASS_NAMES[bearing]}${regionName ? ` of ${regionName}` : ""}`} />
        <KV k="Region" v={regionName} />
        <KV k="Position" v={`${n.lat.toFixed(3)}°, ${n.lng.toFixed(3)}°`} />
        <KV k="Elevation" v={`${Math.round(n.elevation)} m`} />
        <KV k="Fuel load" v={`${Math.round(type.fuel * 100)}%`} />
        <KV
          k="Nearest hotspot"
          v={sample ? (Number.isFinite(sample.nearestHotspotKm) ? `${sample.nearestHotspotKm.toFixed(1)} km` : "> 500 km") : "…"}
          accent={sample && sample.nearestHotspotKm < 30 ? "var(--color-risk-high)" : undefined}
        />
        {air && (
          <>
            <div className="mt-2 mb-1 label-xs">Air quality · smoke estimate</div>
            <KV k="Level" v={`${air.level} · AQHI ~${air.aqhi}`} accent={airAccent} />
            <KV k="Reason" v={air.reason} accent={airAccent} />
          </>
        )}
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
            {day === 0 && cell?.now && Number.isFinite(cell.now.rain) && cell.now.rain > 0 && <KV k={snowShare(cell.now.temp) >= 0.5 ? "Snowing now" : "Raining now"} v={`${fx(cell.now.rain, 1)} mm/h (water)`} />}
            <KV k="Max temp / min RH" v={`${fx(wx.temp)}°C / ${fx(wx.rh)}%`} />
            <KV k="Wind" v={`${fx(wx.wind)} km/h${Number.isFinite(wx.windFrom) ? ` from ${compass(wx.windFrom)} (${Math.round(wx.windFrom)}°)` : ""}`} />
            <KV k={snowShare(wx.temp) >= 0.5 ? "Snow (day, as water)" : "Rain (day)"} v={`${fx(wx.rainMm, 1)} mm`} />
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
          className="flex flex-1 items-center justify-center gap-1.5 border border-line py-1.5 text-[10.5px] tracking-wide text-ink-dim transition hover:border-phos hover:text-phos"
        >
          <Crosshair size={12} /> Focus
        </button>
        <button
          disabled={isFlagged}
          onClick={() => engine?.flag(n)}
          className="flex flex-1 items-center justify-center gap-1.5 border py-1.5 text-[10.5px] tracking-wide transition disabled:opacity-50"
          style={{ borderColor: "var(--color-water)", color: "var(--color-water)" }}
        >
          <Flag size={12} /> {isFlagged ? "Flagged" : "Flag patrol"}
        </button>
      </div>
    </Panel>
  );
}
