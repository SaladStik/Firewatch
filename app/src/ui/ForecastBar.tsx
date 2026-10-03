/**
 * Forecast day picker. Community risk chips stay out of the way on small/medium screens.
 */
import { fireHotspotsOf } from "../state/fires";
import { useMemo } from "react";
import { communityThreats } from "../data/communityRisk";
import { FORECAST_DAYS } from "../data/openMeteo";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

const MIN_POP = 200;
const MAX_SHOWN = 4;

export function ForecastBar({ engine }: { engine: Engine | null }) {
  const day = useStore(app, (s) => s.forecastDay);
  const weather = useStore(app, (s) => s.weather);
  const status = useStore(app, (s) => s.dataStatus);
  const places = useStore(app, (s) => s.places);
  const sim = useStore(app, (s) => s.simulation);
  // Heat that counts as fire (likely farm burns left out, reported fires added): state/fires.ts.
  const hotspots = useStore(app, fireHotspotsOf);
  const perimeters = useStore(app, (s) => s.perimeters);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const focus = useFocusIndices();

  const atRisk = useMemo(() => {
    return communityThreats({
      places: places.filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region)),
      hotspots: hotspots.filter((h) => h.agency !== "SIMULATION"),
      perimeters, weather, day, boost: 1, spread: sim ? null : spread, growth,
    });
  }, [places, weather, day, focus, sim, hotspots, perimeters, spread, growth]);

  if (!weather.length) {
    if (status.weather === "loading") return null;
    return (
      <div className="panel hud-strip pointer-events-auto flex items-center text-[10px]">
        <span className="label-xs">Forecast</span>
        <span className="text-ink-mute truncate">
          Weather unavailable{status.weatherError ? ` · ${status.weatherError}` : ""}
        </span>
      </div>
    );
  }
  const dates = weather[0].dates;

  return (
    <div className="panel hud-strip pointer-events-auto flex items-center !py-0.5">
      <span className="label-xs shrink-0">Day</span>
      <div className="scroll-thin flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
          <button
            key={d}
            onClick={() => engine?.setForecastDay(d)}
            aria-pressed={d === day}
            className={`hud-chip shrink-0 ${d === day ? "!border-phos !text-phos" : ""}`}
          >
            {dayLabel(d, dates)}
          </button>
        ))}
      </div>
      {atRisk.length > 0 && (
        <div className="scroll-thin ml-1 hidden min-w-0 max-w-[12rem] items-center gap-0.5 overflow-x-auto border-l border-line pl-1 xl:flex">
          {atRisk.slice(0, MAX_SHOWN).map(({ place: p, score, reason }) => (
            <button
              key={`${p.region}-${p.name}-${p.lat}`}
              onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
              className="hud-chip shrink-0"
              title={`Threat ${Math.round(score * 100)} · ${reason}`}
            >
              {p.name}
            </button>
          ))}
          {atRisk.length > MAX_SHOWN && <span className="text-[9px] text-ink-mute">+{atRisk.length - MAX_SHOWN}</span>}
        </div>
      )}
    </div>
  );
}
