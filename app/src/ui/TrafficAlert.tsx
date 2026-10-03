/**
 * Highway corridors with a fire near them, worst first. Scored by the engine
 * (data/trafficRisk.ts) so this list and the vehicles on the map are the same numbers.
 *
 * The volume shown is what that stretch of road is expected to carry on the selected forecast
 * day, from the province's measured counts (data/traffic.ts). In the demo scenario it also
 * carries the evacuation leaving the threatened towns, and fire can close the road outright —
 * both flagged, like the rest of the scenario. Click a corridor to fly to the point where the
 * fire comes closest to it; at street zoom you can watch the traffic itself.
 */
import { AlertTriangle, Truck } from "lucide-react";
import { FREIGHT_SHARE } from "../data/trafficRisk";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { dayLabel } from "./weatherFormat";

const MAX_SHOWN = 5;
const AMBER = "#b8791f";

/** 980 → "980", 15437 → "15,400". Volumes are only meaningful to a couple of digits. */
const fmtVolume = (v: number) => (Math.round(v / (v >= 10_000 ? 100 : 10)) * (v >= 10_000 ? 100 : 10)).toLocaleString();

export function TrafficAlert({ engine }: { engine: Engine | null }) {
  const on = useStore(app, (s) => s.layers.traffic);
  const atRisk = useStore(app, (s) => s.trafficThreats);
  const day = useStore(app, (s) => s.forecastDay);
  const dates = useStore(app, (s) => s.weather[0]?.dates);
  const sim = useStore(app, (s) => s.simulation);

  if (!on || !atRisk.length) return null;
  const closed = atRisk.filter((t) => t.closed).length;
  return (
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-center gap-1 px-2 py-1.5" style={{ borderColor: `${AMBER}66` }}>
      <span className="label-xs mr-1 flex shrink-0 items-center gap-1.5" style={{ color: AMBER }}>
        <Truck size={11} />
        Corridors at risk · {dayLabel(day, dates)}
        {closed > 0 && <span className="text-risk-ext">· {closed} closed</span>}
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {atRisk.slice(0, MAX_SHOWN).map((t) => (
          <button
            key={`${t.region}-${t.highway.n}-${t.highway.cls}`}
            onClick={() => engine?.flyToLatLng(t.lat, t.lng, 25)}
            title={[
              `Hwy ${t.highway.n} · ${t.reason} · threat ${Math.round(t.score * 100)}`,
              `${fmtVolume(t.volume)} vehicles/day expected here, ${t.highway.commercial}% commercial`,
              t.surge > 0 ? `Includes ${fmtVolume(t.surge)}/day leaving town (simulated)` : "",
              t.jam > 0 ? `Congestion ${Math.round(t.jam * 100)}% of the way to gridlock` : "",
              t.closed ? "Closed by fire in this scenario, so that traffic has nowhere to go" : "",
              `Measured ${t.highway.lo.toLocaleString()}–${t.highway.hi.toLocaleString()}/day over ${t.highway.km} km, trend ${t.highway.growth >= 0 ? "+" : ""}${t.highway.growth}%/yr`,
              "Zoom to street level to see the traffic itself",
            ].filter(Boolean).join("\n")}
            className="shrink-0 whitespace-nowrap border px-2 py-1 text-[10.5px] text-ink-dim transition hover:text-ink"
            style={{ borderColor: t.closed ? "var(--color-risk-ext)" : `${AMBER}66` }}
          >
            Hwy {t.highway.n}
            {t.closed
              // A closure is only as serious as the traffic it strands, so show both.
              ? <span className="text-risk-ext"> · CLOSED <span className="text-ink-mute">· {fmtVolume(t.volume)} stranded</span></span>
              : <span className="text-ink-mute"> · {fmtVolume(t.volume)}/day</span>}
            {t.surge > 0 && <span style={{ color: AMBER }}> ▲{fmtVolume(t.surge)}</span>}
            {t.jam >= 0.25 && !t.closed && <AlertTriangle size={9} className="ml-1 inline align-[-1px]" style={{ color: AMBER }} />}
            {t.highway.commercial >= FREIGHT_SHARE && <Truck size={9} className="ml-1 inline align-[-1px]" style={{ color: AMBER }} />}
            <span className={t.score >= 0.6 ? "text-risk-ext" : "text-risk-high"}> · {t.reason}</span>
          </button>
        ))}
        {atRisk.length > MAX_SHOWN && <span className="shrink-0 self-center text-[10px] text-ink-mute">+{atRisk.length - MAX_SHOWN} more</span>}
      </div>
      {sim && <span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-mute">Evacuation + closures simulated</span>}
    </div>
  );
}
