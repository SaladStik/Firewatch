/** Communities inside the projected fire spread for the selected day (scenario model). */
import { useMemo } from "react";
import { growthLookup } from "../world/fireGrowth";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

const MAX_SHOWN = 6;
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
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-center gap-1 px-2 py-1.5" style={{ borderColor: `${VIOLET}66` }}>
      <span className="label-xs mr-1 shrink-0" style={{ color: VIOLET }}>
        In projected path · by {day === 0 ? "end of today" : dayLabel(day, dates)}
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {threatened.slice(0, MAX_SHOWN).map((p) => (
          <button
            key={`${p.region}-${p.name}-${p.lat}`}
            onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
            className="shrink-0 whitespace-nowrap border px-2 py-1 text-[10.5px] text-ink-dim transition hover:text-ink"
            style={{ borderColor: `${VIOLET}66` }}
          >
            {p.name}
          </button>
        ))}
        {threatened.length > MAX_SHOWN && <span className="shrink-0 self-center text-[10px] text-ink-mute">+{threatened.length - MAX_SHOWN} more</span>}
      </div>
      <span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-mute">Scenario, not a forecast</span>
    </div>
  );
}
