/** Forecast slider: re-scores the map for a chosen day, and lists the communities most at risk that day. */
import { useMemo } from "react";
import { FORECAST_DAYS, PAST_DAYS, weatherAt } from "../data/openMeteo";
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
  const focus = useFocusIndices();

  const atRisk = useMemo(
    () => places
      .filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region))
      .flatMap((p) => {
        const w = weatherAt(weather, p.lat, p.lng)?.days[day];
        return w ? [{ p, w }] : [];
      })
      .sort((a, b) => b.w.ffwi - a.w.ffwi)
      .slice(0, 5),
    [places, weather, day, focus],
  );

  if (!weather.length) return null;
  const dates = weather[0].dates;

  return (
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-stretch">
      <div className="flex items-center gap-1 border-r border-line px-2 py-1.5">
        <span className="label-xs mr-1">Forecast</span>
        {Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
          <button
            key={d}
            onClick={() => engine?.setForecastDay(d)}
            aria-pressed={d === day}
            className={`border px-2 py-1 text-[10.5px] tracking-widest transition ${d === day ? "border-phos text-phos-glow" : "border-line text-ink-dim hover:border-phos"}`}
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
            title={`Fosberg FFWI ${w.ffwi.toFixed(1)} · ${w.daysSinceRain > PAST_DAYS ? `${PAST_DAYS}+` : w.daysSinceRain} days since rain`}
          >
            {p.name} <span className="text-risk-high tabular-nums">{w.ffwi.toFixed(0)}</span>
          </button>
        ))}
        {day > 0 && <span className="ml-auto shrink-0 text-[10px] text-ink-mute">Fires shown as observed now</span>}
      </div>
    </div>
  );
}
