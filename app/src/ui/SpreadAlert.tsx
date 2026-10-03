/** Communities inside the projected fire spread for the selected day (scenario model). */
import { useMemo } from "react";
import { growthLookup } from "../world/fireGrowth";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

const MAX_SHOWN = 3;
const VIOLET = "#6b3d8a";

export function SpreadAlert({ engine }: { engine: Engine | null }) {
  const spread = useStore(app, (s) => s.spread);
  const places = useStore(app, (s) => s.places);
  const day = useStore(app, (s) => s.forecastDay);
  const dates = useStore(app, (s) => s.weather[0]?.dates);
  const focus = useFocusIndices();

  const threatened = useMemo(() => {
    if (!spread?.cells.length) return [];
    const dayAt = growthLookup(spread);
    return places
      .filter((p) => !p.landmark && focus.has(p.region))
      .filter((p) => {
        const w = project(p.lat, p.lng);
        return dayAt(w.x, w.z) >= 0;
      })
      .sort((a, b) => b.pop - a.pop);
  }, [spread, places, focus]);

  if (!threatened.length) return null;
  return (
    <div
      className="panel hud-strip pointer-events-auto flex items-center"
      style={{ borderColor: `${VIOLET}55` }}
      title="Scenario, not a forecast"
    >
      <span className="label-xs shrink-0" style={{ color: VIOLET }}>
        Path · {day === 0 ? "today" : dayLabel(day, dates)}
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {threatened.slice(0, MAX_SHOWN).map((p) => (
          <button
            key={`${p.region}-${p.name}-${p.lat}`}
            onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
            className="hud-chip shrink-0"
            style={{ borderColor: `${VIOLET}55` }}
          >
            {p.name}
          </button>
        ))}
        {threatened.length > MAX_SHOWN && (
          <span className="shrink-0 self-center text-[9px] text-ink-mute">+{threatened.length - MAX_SHOWN}</span>
        )}
      </div>
    </div>
  );
}
