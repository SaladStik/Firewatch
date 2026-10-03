/** Bottom strip: headline situation numbers (compact). */
import { useMemo } from "react";
import { isPerimeterActive, SIM_WEATHER_BOOST, simulatedHotspots } from "../data/hazards";
import { useFocusIndices } from "./region";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="px-2.5 py-1">
      <div className="text-[12px] font-bold tabular-nums leading-none" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-[8.5px] font-bold tracking-[0.06em] uppercase text-ink-mute">{label}</div>
    </div>
  );
}

export function FireFeed({ engine: _engine }: { engine: Engine | null }) {
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const weather = useStore(app, (s) => s.weather);
  const sim = useStore(app, (s) => s.simulation);
  const day = useStore(app, (s) => s.forecastDay);
  const regions = useStore(app, (s) => s.regions);
  const focus = useFocusIndices();

  const all = useMemo(
    () => (sim ? [...hotspots, ...regions.flatMap((r, i) => simulatedHotspots(r.demoSites).map((h) => ({ ...h, region: i })))] : hotspots),
    [hotspots, sim, regions],
  );
  const focusHs = useMemo(() => all.filter((h) => focus.has(h.region ?? -1)), [all, focus]);
  const elsewhere = all.length - focusHs.length;
  const focusPer = perimeters.filter((p) => focus.has(p.region ?? -1));
  const active = focusPer.filter((p) => isPerimeterActive(p)).length;
  const burnedHa = focusPer.reduce((a, p) => a + p.areaHa, 0);
  const wxCells = weather.flatMap((w) => w.cells);
  const wxMax = wxCells.length ? Math.max(...wxCells.map((c) => c.days[day]?.risk ?? 0)) * (sim ? SIM_WEATHER_BOOST : 1) : 0;

  return (
    <div data-tour="fire-feed" className="panel hud-strip pointer-events-auto flex items-stretch !p-0">
      <div className="flex items-center border-r border-line px-2">
        <span className="label-xs">Sitrep</span>
      </div>
      <div className="flex divide-x divide-line">
        <Metric label="Hotspots" value={focusHs.length} color="var(--color-fire)" />
        <Metric label="Else" value={elsewhere} color="var(--color-ink-dim)" />
        <Metric label="Perim." value={active} color="var(--color-risk-ext)" />
        <Metric label="Burned" value={`${Math.round(burnedHa / 1000)}k ha`} color="var(--color-risk-high)" />
        <Metric label={day === 0 ? "Wx" : `Wx +${day}d`} value={Math.round(Math.min(1, wxMax) * 100)} color="var(--color-risk-elev)" />
      </div>
    </div>
  );
}
