/**
 * Highway corridors with a fire near them, worst first (data/trafficRisk.ts).
 *
 * The volume shown is what that stretch of road is expected to carry on the selected
 * forecast day, from the province's measured counts (data/traffic.ts). Click a corridor to
 * fly to the point where the fire comes closest to it.
 */
import { useMemo } from "react";
import { Truck } from "lucide-react";
import { corridorThreats, FREIGHT_SHARE } from "../data/trafficRisk";
import { SIM_WEATHER_BOOST, simulatedHotspots } from "../data/hazards";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";

const MAX_SHOWN = 5;
const AMBER = "#b8791f";
/** Clock for the seasonal factor while the forecast dates are still loading. */
const LOADED_AT = new Date();

/** 980 → "980", 15400 → "15,400". Volumes are only meaningful to a couple of digits. */
const fmtVolume = (v: number) => Math.round(v / (v >= 10_000 ? 100 : 10)) * (v >= 10_000 ? 100 : 10);

export function TrafficAlert({ engine }: { engine: Engine | null }) {
  const on = useStore(app, (s) => s.layers.traffic);
  const networks = useStore(app, (s) => s.traffic);
  const day = useStore(app, (s) => s.forecastDay);
  const weather = useStore(app, (s) => s.weather);
  const dates = useStore(app, (s) => s.weather[0]?.dates);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const regions = useStore(app, (s) => s.regions);
  const sim = useStore(app, (s) => s.simulation);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const focus = useFocusIndices();

  const atRisk = useMemo(() => {
    if (!on) return [];
    const fires = sim ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))] : hotspots;
    // The forecast slider picks the day; its date drives the seasonal part of the volume.
    const iso = dates?.[day];
    return corridorThreats({
      networks: networks.filter((n) => focus.has(n.region)),
      hotspots: fires, perimeters, weather, day,
      date: iso ? new Date(`${iso}T12:00:00`) : LOADED_AT,
      boost: sim ? SIM_WEATHER_BOOST : 1, spread, growth,
    });
  }, [on, networks, focus, hotspots, perimeters, weather, day, dates, sim, regions, spread, growth]);

  if (!on || !atRisk.length) return null;
  return (
    <div className="panel pointer-events-auto flex max-w-[min(920px,calc(100vw-32px))] items-center gap-1 px-2 py-1.5" style={{ borderColor: `${AMBER}66` }}>
      <span className="label-xs mr-1 flex shrink-0 items-center gap-1.5" style={{ color: AMBER }}>
        <Truck size={11} />
        Corridors at risk · {dayLabel(day, dates)}
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {atRisk.slice(0, MAX_SHOWN).map((t) => (
          <button
            key={`${t.region}-${t.highway.n}-${t.highway.cls}`}
            onClick={() => engine?.flyToLatLng(t.lat, t.lng, 25)}
            title={[
              `Hwy ${t.highway.n} · ${t.reason} · threat ${Math.round(t.score * 100)}`,
              `${fmtVolume(t.volume).toLocaleString()} vehicles/day expected here, ${t.highway.commercial}% commercial`,
              `Measured ${t.highway.lo.toLocaleString()}–${t.highway.hi.toLocaleString()}/day over ${t.highway.km} km, trend ${t.highway.growth >= 0 ? "+" : ""}${t.highway.growth}%/yr`,
            ].join("\n")}
            className="shrink-0 whitespace-nowrap border px-2 py-1 text-[10.5px] text-ink-dim transition hover:text-ink"
            style={{ borderColor: `${AMBER}66` }}
          >
            Hwy {t.highway.n}
            <span className="text-ink-mute"> · {fmtVolume(t.volume).toLocaleString()}/day</span>
            {t.highway.commercial >= FREIGHT_SHARE && <Truck size={9} className="ml-1 inline align-[-1px]" style={{ color: AMBER }} />}
            <span className={t.score >= 0.6 ? "text-risk-ext" : "text-risk-high"}> · {t.reason}</span>
          </button>
        ))}
        {atRisk.length > MAX_SHOWN && <span className="shrink-0 self-center text-[10px] text-ink-mute">+{atRisk.length - MAX_SHOWN} more</span>}
      </div>
    </div>
  );
}
