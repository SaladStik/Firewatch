/** Forecast slider: re-scores the map for a chosen day, and lists the communities most at risk that day. */
import { useMemo } from "react";
import { SIM_WEATHER_BOOST } from "../data/hazards";
import { FORECAST_DAYS, PAST_DAYS, weatherAt, type WeatherCell } from "../data/openMeteo";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

/** Communities smaller than this are left out of the at-risk list. */
const MIN_POP = 1000;

export function ForecastBar({ engine }: { engine: Engine | null }) {
  const day = useStore(app, (s) => s.forecastDay);
  const weather = useStore(app, (s) => s.weather);
  const places = useStore(app, (s) => s.places);
  const sim = useStore(app, (s) => s.simulation);
  const focus = useFocusIndices();

  const atRisk = useMemo(() => {
    // Weather cells are ~160 km: keep the biggest town per cell so the list shows 5 distinct areas.
    const seen = new Set<WeatherCell>();
    return places
      .filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region))
      .flatMap((p) => {
        const c = weatherAt(weather, p.lat, p.lng);
        const w = c?.days[day];
        return c && w ? [{ p, w, c }] : [];
      })
      .sort((a, b) => b.w.risk - a.w.risk || b.p.pop - a.p.pop)
      .filter(({ c }) => !seen.has(c) && !!seen.add(c))
      .slice(0, 5);
  }, [places, weather, day, focus]);

  if (!weather.length) return null;
  const dates = weather[0].dates;
  // Same scale as the map colour and "Peak wx risk".
  const score = (risk: number) => Math.round(Math.min(1, risk * (sim ? SIM_WEATHER_BOOST : 1)) * 100);

  return (
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-stretch">
      <div className="scroll-thin flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-1.5 lg:border-r lg:border-line">
        <span className="label-xs mr-1 hidden shrink-0 sm:inline">Forecast</span>
        {Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
          <button
            key={d}
            onClick={() => engine?.setForecastDay(d)}
            aria-pressed={d === day}
            className={`shrink-0 whitespace-nowrap border px-2 py-1 text-[10.5px] tracking-widest transition ${d === day ? "border-phos text-phos-glow" : "border-line text-ink-dim hover:border-phos"}`}
          >
            {dayLabel(d, dates)}
          </button>
        ))}
      </div>
      <div className="scroll-thin hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 lg:flex">
        <span className="label-xs mr-1 shrink-0">Most at risk</span>
        {atRisk.map(({ p, w }) => (
          <button
            key={`${p.region}-${p.name}`}
            onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
            className="shrink-0 border border-line px-2 py-1 text-[10.5px] text-ink-dim transition hover:border-risk-high"
            title={`Risk ${score(w.risk)} · Fosberg FFWI ${w.ffwi.toFixed(1)} · ${w.daysSinceRain > PAST_DAYS ? `${PAST_DAYS}+` : w.daysSinceRain} days since rain`}
          >
            {p.name} <span className="text-risk-high tabular-nums">{score(w.risk)}</span>
          </button>
        ))}
        {day > 0 && <span className="ml-auto shrink-0 text-[10px] text-ink-mute">Fires shown as observed now</span>}
      </div>
    </div>
  );
}
