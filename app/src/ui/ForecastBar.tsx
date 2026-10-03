/**
 * Forecast slider: re-scores the map for a chosen day, and lists the communities that are
 * actually threatened that day (a fire nearby, in a projected path, or High fire weather;
 * data/communityRisk.ts). Quiet days say so instead of naming random towns.
 */
import { useMemo } from "react";
import { communityThreats } from "../data/communityRisk";
import { FORECAST_DAYS } from "../data/openMeteo";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

/** Smaller places are left out unless a fire is right on them. */
const MIN_POP = 200;
const MAX_SHOWN = 6;

export function ForecastBar({ engine }: { engine: Engine | null }) {
  const day = useStore(app, (s) => s.forecastDay);
  const weather = useStore(app, (s) => s.weather);
  const status = useStore(app, (s) => s.dataStatus);
  const places = useStore(app, (s) => s.places);
  const sim = useStore(app, (s) => s.simulation);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const focus = useFocusIndices();

  const atRisk = useMemo(() => {
    // Live fires and weather only. The demo scenario and the demo instrument stations stay out of this list.
    return communityThreats({
      places: places.filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region)),
      hotspots: hotspots.filter((h) => h.agency !== "SIMULATION"),
      perimeters, weather, day, boost: 1, spread: sim ? null : spread, growth,
    });
  }, [places, weather, day, focus, sim, hotspots, perimeters, spread, growth]);

  if (!weather.length) {
    // Keep the bar (and the layout) in place and say why there's no forecast, instead of vanishing.
    if (status.weather === "loading") return null;
    return (
      <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-center gap-3 px-3 py-1.5 text-[10.5px]">
        <span className="label-xs">Forecast</span>
        <span className="text-ink-mute">
          Weather unavailable{status.weatherError ? ` · ${status.weatherError}` : ""}. Fire data still loads; the forecast returns on its own (checked every 10 min).
        </span>
      </div>
    );
  }
  const dates = weather[0].dates;

  return (
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-stretch">
      <div className="flex items-center gap-2 px-3 py-1.5 lg:border-r lg:border-line">
        <span className="label-xs hidden sm:inline">Forecast</span>
      </div>
      <div className="scroll-thin flex min-w-0 items-center gap-1 overflow-x-auto px-2 py-1.5 lg:border-r lg:border-line">
        <span className="label-xs mr-1 hidden shrink-0 sm:inline">Day</span>
        {Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
          <button
            key={d}
            onClick={() => engine?.setForecastDay(d)}
            aria-pressed={d === day}
            className={`shrink-0 whitespace-nowrap border px-2 py-1 text-[10.5px] tracking-wide transition ${d === day ? "border-phos text-phos" : "border-line text-ink-dim hover:border-phos"}`}
          >
            {dayLabel(d, dates)}
          </button>
        ))}
      </div>
      <div className="scroll-thin hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 py-1.5 lg:flex">
        <span className="label-xs mr-1 shrink-0">Communities at risk</span>
        {atRisk.length === 0 && <span className="shrink-0 text-[10.5px] text-ink-mute">None: no fires near towns and no very high fire danger</span>}
        {atRisk.slice(0, MAX_SHOWN).map(({ place: p, score, reason }) => (
          <button
            key={`${p.region}-${p.name}-${p.lat}`}
            onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
            className="shrink-0 border border-line px-2 py-1 text-[10.5px] text-ink-dim transition hover:border-risk-high"
            title={`Threat ${Math.round(score * 100)} · ${reason}`}
          >
            {p.name} <span className={score >= 0.6 ? "text-risk-ext" : "text-risk-high"}>· {reason}</span>
          </button>
        ))}
        {atRisk.length > MAX_SHOWN && <span className="shrink-0 text-[10px] text-ink-mute">+{atRisk.length - MAX_SHOWN} more</span>}
        {day > 0 && <span className="ml-auto shrink-0 text-[10px] text-ink-mute">Fires shown as observed now</span>}
      </div>
    </div>
  );
}
