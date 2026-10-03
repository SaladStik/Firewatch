/**
 * Single bottom dock: sitrep + forecast day + threat chips.
 * One panel instead of five stacked bars so the map stays open.
 */
import { useMemo } from "react";
import { AlertTriangle, MapPin, Truck, Wind } from "lucide-react";
import { airAt } from "../data/airQuality";
import { communityThreats } from "../data/communityRisk";
import { FORECAST_DAYS } from "../data/openMeteo";
import { FREIGHT_SHARE } from "../data/trafficRisk";
import { isPerimeterActive, SIM_WEATHER_BOOST, simulatedHotspots } from "../data/hazards";
import { growthLookup } from "../world/fireGrowth";
import { project } from "../geo/projection";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { useFocusIndices } from "./region";
import { dayLabel } from "./weatherFormat";
import { dispatch } from "../dispatch/store";

const HAZE = "#6b5a4a";
const AMBER = "#b8791f";
const VIOLET = "#6b3d8a";
const PLACE_NEAR = 0.03;
const MIN_POP = 200;

function levelColor(level: string) {
  if (level === "Extreme") return "var(--color-fire)";
  if (level === "Very High") return "var(--color-risk-ext)";
  if (level === "High") return "var(--color-risk-high)";
  if (level === "Good") return "var(--color-phos)";
  return "var(--color-risk-elev)";
}

const fmtVolume = (v: number) =>
  (Math.round(v / (v >= 10_000 ? 100 : 10)) * (v >= 10_000 ? 100 : 10)).toLocaleString();

function Metric({ label, value, color, title }: { label: string; value: string | number; color: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-1 px-1.5" title={title}>
      <span className="text-[12px] font-bold tabular-nums leading-none" style={{ color }}>{value}</span>
      <span className="text-[8.5px] font-bold tracking-[0.06em] uppercase text-ink-mute">{label}</span>
    </div>
  );
}

export function StatusDock({ engine, embedded }: { engine: Engine | null; embedded?: boolean }) {
  const hotspots = useStore(app, (s) => s.hotspots);
  const reportedFires = useStore(app, (s) => s.reportedFires);
  const perimeters = useStore(app, (s) => s.perimeters);
  const weather = useStore(app, (s) => s.weather);
  const sim = useStore(app, (s) => s.simulation);
  const day = useStore(app, (s) => s.forecastDay);
  // While Dispatch's 311 tab is open, the days are the crews' schedule too: each shows its safety jobs.
  const schedule = useStore(dispatch, (s) => (s.open && s.tab === "311" ? s.schedule311 : null));
  const regions = useStore(app, (s) => s.regions);
  const places = useStore(app, (s) => s.places);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const status = useStore(app, (s) => s.dataStatus);
  const airOn = useStore(app, (s) => s.layers.air);
  const trafficOn = useStore(app, (s) => s.layers.traffic);
  const atRiskAir = useStore(app, (s) => s.airThreats);
  const atRiskRoads = useStore(app, (s) => s.trafficThreats);
  const selected = useStore(app, (s) => s.selected);
  const hover = useStore(app, (s) => s.hover);
  const focus = useFocusIndices();
  const dates = weather[0]?.dates;

  // Official fires are what count as fires; hotspots are unconfirmed heat (often farm burns).
  // The demo scenario adds one simulated out-of-control fire per demo site.
  const focusFires = reportedFires.filter((f) => focus.has(f.region ?? -1));
  const simFires = sim ? regions.reduce((a, r, i) => a + (focus.has(i) ? r.demoSites.length : 0), 0) : 0;
  const fireCount = focusFires.length + simFires;
  const outOfControl = focusFires.filter((f) => f.stage === "out_of_control").length + simFires;
  const heat = hotspots.filter((h) => focus.has(h.region ?? -1)).length;
  const focusPer = perimeters.filter((p) => focus.has(p.region ?? -1));
  const active = focusPer.filter((p) => isPerimeterActive(p)).length;
  const burnedHa = focusPer.reduce((a, p) => a + p.areaHa, 0);
  const wxCells = weather.flatMap((w) => w.cells);
  const wxMax = wxCells.length ? Math.max(...wxCells.map((c) => c.days[day]?.risk ?? 0)) * (sim ? SIM_WEATHER_BOOST : 1) : 0;

  const pathTowns = useMemo(() => {
    if (!spread?.cells.length) return [];
    const dayAt = growthLookup(spread);
    return places
      .filter((p) => !p.landmark && focus.has(p.region))
      .filter((p) => {
        const w = project(p.lat, p.lng);
        return dayAt(w.x, w.z) >= 0;
      })
      .sort((a, b) => b.pop - a.pop)
      .slice(0, 3);
  }, [spread, places, focus]);

  const focusPt = selected ?? hover;
  const airHere = useMemo(() => {
    if (!airOn || focusPt == null) return null;
    const fires = sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
    const reading = airAt(focusPt.lat, focusPt.lng, {
      hotspots: fires, perimeters, weather, day, spread, growth,
    });
    let label = `${reading.lat.toFixed(2)}°, ${reading.lng.toFixed(2)}°`;
    let best = PLACE_NEAR;
    for (const p of places) {
      if (p.landmark) continue;
      const d = Math.hypot(p.lat - reading.lat, p.lng - reading.lng);
      if (d < best) { best = d; label = p.name; }
    }
    return { ...reading, label };
  }, [airOn, focusPt, places, hotspots, perimeters, weather, day, spread, growth, sim, regions]);

  const airOthers = useMemo(() => {
    if (!airOn) return [];
    return atRiskAir.filter((t) => {
      if (!airHere) return true;
      return Math.hypot(t.place.lat - airHere.lat, t.place.lng - airHere.lng) > PLACE_NEAR;
    }).slice(0, 2);
  }, [airOn, atRiskAir, airHere]);

  const roadChips = trafficOn ? atRiskRoads.slice(0, 3) : [];

  const communityChips = useMemo(() => {
    if (!weather.length) return [];
    return communityThreats({
      places: places.filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region)),
      hotspots: hotspots.filter((h) => h.agency !== "SIMULATION"),
      perimeters, weather, day, boost: 1, spread: sim ? null : spread, growth,
    }).slice(0, 3);
  }, [places, weather, day, focus, sim, hotspots, perimeters, spread, growth]);

  const hasAlerts = pathTowns.length > 0 || !!airHere || airOthers.length > 0 || roadChips.length > 0;

  return (
    <div data-tour="fire-feed" className={embedded ? "flex w-full min-w-0 flex-col justify-center" : "panel hud-dock pointer-events-auto flex w-full flex-col"}>
      {/* Sitrep + day on one row */}
      <div className="flex h-9 min-w-0 items-center gap-2 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <span className="label-xs mr-1 shrink-0">Sitrep</span>
          <Metric label="fires" value={fireCount} color="var(--color-fire)" title={`Active wildfires reported by fire agencies in focus${simFires ? ` (incl. ${simFires} simulated)` : ""}`} />
          <Metric label="ooc" value={outOfControl} color="var(--color-risk-ext)" title="Out of control" />
          <Metric label="heat" value={heat} color="var(--color-ink-dim)" title="Satellite hotspots, last 24 h: unconfirmed heat detections (often farm or controlled burns)" />
          <Metric label="perim" value={active} color="var(--color-risk-ext)" />
          <Metric label="burned" value={`${Math.round(burnedHa / 1000)}k`} color="var(--color-risk-high)" />
          <Metric label="wx" value={Math.round(Math.min(1, wxMax) * 100)} color="var(--color-risk-elev)" />
        </div>
        <div className="h-4 w-px shrink-0 bg-line" />
        <div className="flex shrink-0 items-center gap-0.5">
          {!weather.length ? (
            <span className="text-[9px] text-ink-mute">
              {status.weather === "loading" ? "…" : "no wx"}
            </span>
          ) : (
            Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
              <button
                key={d}
                type="button"
                onClick={() => engine?.setForecastDay(d)}
                aria-pressed={d === day}
                title={schedule?.[d] ? `311 schedule: ${schedule[d].jobs} jobs, ${schedule[d].safetyJobs} safety, ${schedule[d].open.toLocaleString("en-CA")} open that morning` : undefined}
                className={`hud-chip shrink-0 ${d === day ? "!border-phos !text-phos" : ""}`}
              >
                {dayLabel(d, dates)}
                {schedule && <span className="ml-1 tabular-nums opacity-70">{schedule[d] ? schedule[d].safetyJobs : "·"}</span>}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Threats — one chip rail, not separate bars */}
      {hasAlerts && (
        <div className="flex min-w-0 items-center gap-1.5 border-t border-line px-2 py-1">
          <div className="scroll-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {pathTowns.map((p) => (
              <button
                key={`path-${p.region}-${p.name}`}
                type="button"
                onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
                className="hud-chip shrink-0"
                style={{ borderColor: `${VIOLET}66`, color: VIOLET }}
                title="In projected path · scenario"
              >
                Path · {p.name}
              </button>
            ))}
            {airHere && (
              <button
                type="button"
                onClick={() => engine?.flyToLatLng(airHere.lat, airHere.lng, 20)}
                className="hud-chip shrink-0"
                style={{ borderColor: `${HAZE}88`, background: `${HAZE}14` }}
                title={`Air · AQHI ~${airHere.aqhi} · ${airHere.reason}`}
              >
                <Wind size={9} className="mr-0.5 inline align-[-1px]" style={{ color: HAZE }} />
                <MapPin size={9} className="mr-0.5 inline align-[-1px]" />
                {airHere.label}
                <span style={{ color: levelColor(airHere.level) }}> · {airHere.level}</span>
              </button>
            )}
            {airOthers.map((t) => (
              <button
                key={`air-${t.place.region}-${t.place.name}`}
                type="button"
                onClick={() => engine?.flyToLatLng(t.place.lat, t.place.lng, 25)}
                className="hud-chip shrink-0"
                style={{ borderColor: `${HAZE}55` }}
                title={`AQHI ~${t.aqhi} · ${t.reason}`}
              >
                {t.place.name}
                <span style={{ color: levelColor(t.level) }}> · {t.level}</span>
              </button>
            ))}
            {roadChips.map((t) => (
              <button
                key={`road-${t.region}-${t.highway.n}-${t.highway.cls}`}
                type="button"
                onClick={() => engine?.flyToLatLng(t.lat, t.lng, 25)}
                className="hud-chip shrink-0"
                style={{ borderColor: t.closed ? "var(--color-risk-ext)" : `${AMBER}66` }}
                title={`Hwy ${t.highway.n} · ${t.reason}`}
              >
                <Truck size={9} className="mr-0.5 inline align-[-1px]" style={{ color: AMBER }} />
                Hwy {t.highway.n}
                {t.closed ? <span className="text-risk-ext"> · CLOSED</span> : <span className="text-ink-mute"> · {fmtVolume(t.volume)}</span>}
                {t.jam >= 0.25 && !t.closed && <AlertTriangle size={8} className="ml-0.5 inline align-[-1px]" style={{ color: AMBER }} />}
                {t.highway.commercial >= FREIGHT_SHARE && <Truck size={8} className="ml-0.5 inline align-[-1px]" style={{ color: AMBER }} />}
              </button>
            ))}
            {communityChips.length > 0 && pathTowns.length === 0 && (
              communityChips.map(({ place: p, score, reason }) => (
                <button
                  key={`town-${p.region}-${p.name}`}
                  type="button"
                  onClick={() => engine?.flyToLatLng(p.lat, p.lng, 25)}
                  className="hud-chip shrink-0"
                  title={`Threat ${Math.round(score * 100)} · ${reason}`}
                >
                  {p.name}
                  <span className={score >= 0.6 ? "text-risk-ext" : "text-risk-high"}> · {reason}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
