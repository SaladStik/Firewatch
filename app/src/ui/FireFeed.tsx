/** Bottom strip: headline numbers + strongest hotspots (click to fly). */
import { useMemo } from "react";
import { isPerimeterActive, SIM_WEATHER_BOOST, simulatedHotspots } from "../data/hazards";
import { useFocusIndices } from "./region";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="px-4 py-2">
      <div className="text-[18px] font-bold tabular-nums leading-none" style={{ color }}>{value}</div>
      <div className="label-xs mt-1">{label}</div>
    </div>
  );
}

export function FireFeed({ engine }: { engine: Engine | null }) {
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const weather = useStore(app, (s) => s.weather);
  const sim = useStore(app, (s) => s.simulation);
  const day = useStore(app, (s) => s.forecastDay);
  const regions = useStore(app, (s) => s.regions);
  const focus = useFocusIndices();

  // Headline numbers cover the regions in focus; everything else is "elsewhere".
  const all = useMemo(
    () => (sim ? [...hotspots, ...regions.flatMap((r, i) => simulatedHotspots(r.demoSites).map((h) => ({ ...h, region: i })))] : hotspots),
    [hotspots, sim, regions],
  );
  const focusHs = useMemo(() => all.filter((h) => focus.has(h.region ?? -1)), [all, focus]);
  const elsewhere = all.length - focusHs.length;
  const top = useMemo(() => [...focusHs].sort((a, b) => b.frp - a.frp).slice(0, 12), [focusHs]);
  const focusPer = perimeters.filter((p) => focus.has(p.region ?? -1));
  const active = focusPer.filter((p) => isPerimeterActive(p)).length;
  const burnedHa = focusPer.reduce((a, p) => a + p.areaHa, 0);
  const wxCells = weather.flatMap((w) => w.cells);
  const wxMax = wxCells.length ? Math.max(...wxCells.map((c) => c.days[day]?.risk ?? 0)) * (sim ? SIM_WEATHER_BOOST : 1) : 0;

  return (
    <div data-tour="fire-feed" className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-stretch">
      <div className="flex items-center gap-2 border-r border-line px-3">
        <span className="label-xs hidden sm:inline">Situation</span>
      </div>
      <div className="flex divide-x divide-line border-r border-line">
        <Metric label="Hotspots 24h" value={focusHs.length} color="var(--color-fire)" />
        <Metric label="Elsewhere 24h" value={elsewhere} color="var(--color-ink-dim)" />
        <Metric label="Active perim." value={active} color="var(--color-risk-ext)" />
        <Metric label={`Burned ${new Date().getFullYear()}`} value={`${Math.round(burnedHa / 1000)}k ha`} color="var(--color-risk-high)" />
        <Metric label={day === 0 ? "Peak wx risk" : `Peak wx risk +${day}d`} value={Math.round(Math.min(1, wxMax) * 100)} color="var(--color-risk-elev)" />
      </div>
      <div className="scroll-thin hidden min-w-0 flex-1 gap-1 overflow-x-auto px-2 py-1.5 lg:flex">
        {top.length === 0 && <div className="self-center px-2 text-[11px] text-ink-mute">No satellite hotspots in the last 24h.</div>}
        {top.map((h) => (
          <button
            key={h.id}
            onClick={() => engine?.flyToLatLng(h.lat, h.lng, 20)}
            className="shrink-0 border border-line px-2 py-1 text-left transition hover:border-fire"
          >
            <div className="flex items-center gap-1.5 text-[10.5px]" style={{ color: h.agency === "SIMULATION" ? "var(--color-risk-high)" : "var(--color-fire)" }}>
              <span className="h-1.5 w-1.5 animate-pulse" style={{ background: "currentColor" }} />
              {h.frp.toFixed(0)} MW
            </div>
            <div className="text-[9.5px] tabular-nums text-ink-mute">{h.lat.toFixed(2)}, {h.lng.toFixed(2)} · {h.sensor}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
