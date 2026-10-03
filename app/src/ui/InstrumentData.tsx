/** Station list with the same Open-Meteo weather and Canadian FWI the map uses. */
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import stations from "../../../wildfire/instruments.json";
import type { Engine } from "../engine";
import { isPerimeterActive, simulatedHotspots } from "../data/hazards";
import { perimeterAt, reachScale, type FireGrowth } from "../data/fireHistory";
import type { Hotspot, Perimeter } from "../data/cwfis";
import { FORECAST_DAYS, weatherAt, type DayWeather, type WeatherCell, type WeatherGrid } from "../data/openMeteo";
import { project } from "../geo/projection";
import { app } from "../state/app";
import { growthLookup, type GrowthField } from "../world/fireGrowth";
import { downwind, SPREAD_MAX_KM, spreadInfluence } from "../world/spread";
import { useStore } from "../state/store";
import { AppBar, BarButton } from "./Hud";
import { KV } from "./primitives";
import { dayLabel } from "./weatherFormat";

type Station = {
  id: string;
  name: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  dashboard: string | null;
};

type Reading = {
  ok: boolean;
  label: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  wind_kmh: number | null;
  /** Canadian FWI for the selected forecast day. */
  fwi: number | null;
  /** 0..1. Weather danger, raised when a fire is close or downwind. */
  risk: number | null;
  /** How the closeness changed the score, e.g. "fire 18 km W". */
  near: string | null;
  /** Fosberg, kept beside FWI the same way the map does. */
  ffwi: number | null;
  category: string | null;
  day: DayWeather | null;
  cell: WeatherCell | null;
};

type Instrument = Station & { reading: Reading };

const STATIONS = (stations as Station[]).filter((s) => s.latitude != null && s.longitude != null);

function finite(n: number | undefined | null): number | null {
  return n != null && Number.isFinite(n) ? n : null;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const RANKS = ["Low", "Moderate", "High", "Very High", "Extreme"];

type Fire = { x: number; z: number; dx: number; dz: number; stretch: number; scale: number };

function buildFires(hotspots: Hotspot[], perimeters: Perimeter[], weather: WeatherGrid[], day: number, growth: Record<string, FireGrowth>): Fire[] {
  const fires: Fire[] = [];
  const windAt = (lat: number, lng: number) => {
    const w = weatherAt(weather, lat, lng)?.days[day];
    const calm = !w || !Number.isFinite(w.windFrom) || !Number.isFinite(w.wind);
    return downwind(calm ? 0 : w.windFrom, calm ? 0 : w.wind);
  };
  for (const h of hotspots) {
    const fire = perimeters.find((p) => growth[p.id] && isPerimeterActive(p) && perimeterAt([p], h.lat, h.lng));
    fires.push({ ...project(h.lat, h.lng), ...windAt(h.lat, h.lng), scale: fire ? reachScale(growth[fire.id].k) : 1 });
  }
  for (const p of perimeters) {
    if (!isPerimeterActive(p)) continue;
    const ring = p.rings[0] ?? [];
    const step = Math.max(1, Math.floor(ring.length / 24));
    const scale = growth[p.id] ? reachScale(growth[p.id].k) : 1;
    for (let i = 0; i < ring.length; i += step) fires.push({ ...project(ring[i][1], ring[i][0]), ...windAt(ring[i][1], ring[i][0]), scale });
  }
  return fires;
}

/** Same idea as the map: a close or downwind fire raises the weather risk. */
function closeness(lat: number, lng: number, fires: Fire[], spread: GrowthField | null, wx: number) {
  const { x, z } = project(lat, lng);
  let near = Infinity, nearDx = 0, nearDz = 0, influence = 0;
  for (const f of fires) {
    const vx = x - f.x, vz = z - f.z;
    if (Math.abs(vx) > SPREAD_MAX_KM || Math.abs(vz) > SPREAD_MAX_KM) continue;
    const d = Math.hypot(vx, vz);
    if (d < near) { near = d; nearDx = -vx; nearDz = -vz; }
    influence = Math.max(influence, spreadInfluence(vx, vz, f));
  }
  let score = wx;
  let nearLabel: string | null = null;
  if (growthLookup(spread)(x, z) >= 0) {
    score = Math.max(score, 0.9 + 0.1 * wx);
    nearLabel = "in projected path";
  }
  if (influence > 0) {
    const raised = influence * (0.65 + 0.35 * wx);
    if (raised >= score) {
      score = raised;
      const dir = COMPASS[Math.round(((Math.atan2(nearDx, -nearDz) * 180) / Math.PI + 360) % 360 / 45) % 8];
      nearLabel = `fire ${Math.max(1, Math.round(near))} km ${dir}`;
    }
  }
  return { score, near: nearLabel };
}

function raisedCategory(weatherDanger: string, score: number) {
  let fromScore = "Low";
  if (score >= 0.85) fromScore = "Extreme";
  else if (score >= 0.68) fromScore = "Very High";
  else if (score >= 0.5) fromScore = "High";
  else if (score >= 0.25) fromScore = "Moderate";
  const weather = weatherDanger === "Very high" ? "Very High" : weatherDanger;
  return RANKS.indexOf(fromScore) > RANKS.indexOf(weather) ? fromScore : weather;
}

function readingAt(station: Station, weather: WeatherGrid[], day: number, fires: Fire[], spread: GrowthField | null): Reading {
  const cell = station.latitude != null && station.longitude != null ? weatherAt(weather, station.latitude, station.longitude) : null;
  const wx = cell?.days[day];
  if (!cell || !wx || station.latitude == null || station.longitude == null) {
    return { ok: false, label: "No grid", temperature_c: null, humidity_pct: null, wind_kmh: null, fwi: null, risk: null, near: null, ffwi: null, category: null, day: null, cell: null };
  }
  const live = day === 0 ? cell.now : null;
  const wxRisk = Number.isFinite(wx.risk) ? wx.risk : 0;
  const close = closeness(station.latitude, station.longitude, fires, spread, wxRisk);
  return {
    ok: true,
    label: live ? "Live" : "Forecast",
    temperature_c: finite(live?.temp) ?? finite(wx.temp),
    humidity_pct: finite(live?.rh) ?? finite(wx.rh),
    wind_kmh: finite(live?.wind) ?? finite(wx.wind),
    fwi: finite(wx.fwi),
    risk: close.score,
    near: close.near,
    ffwi: finite(wx.ffwi),
    category: raisedCategory(wx.danger, close.score),
    day: wx,
    cell,
  };
}

function dashboardUrl(base: string, theme: "dark" | "light") {
  const url = new URL(base);
  url.searchParams.set("theme", theme);
  return url.toString();
}

function coords(latitude: number | null, longitude: number | null) {
  if (latitude == null || longitude == null) return null;
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(4)}° ${ns}, ${Math.abs(longitude).toFixed(4)}° ${ew}`;
}

const PROVINCES = [
  { id: "Alberta", label: "ALBERTA" },
  { id: "British Columbia", label: "BC" },
  { id: "Saskatchewan", label: "SASKATCHEWAN" },
] as const;

function provinceOf(location: string) {
  const text = location.toLowerCase();
  if (text.includes("alberta")) return "Alberta";
  if (text.includes("british columbia")) return "British Columbia";
  if (text.includes("saskatchewan")) return "Saskatchewan";
  return null;
}

function riskColor(category: string | null) {
  switch (category) {
    case "Low": return "var(--color-water)";
    case "Moderate": return "var(--color-risk-elev)";
    case "High": return "var(--color-risk-high)";
    case "Very high":
    case "Very High": return "var(--color-risk-ext)";
    case "Extreme": return "var(--color-fire)";
    default: return null;
  }
}

const SORTS = [
  { id: "risk", label: "FILTER BY RISK", active: "RISK HIGH TO LOW", desc: true },
  { id: "humidity", label: "HUMIDITY LOW TO HIGH", active: "HUMIDITY LOW TO HIGH", desc: false },
  { id: "temp", label: "TEMP HIGH TO LOW", active: "TEMP HIGH TO LOW", desc: true },
  { id: "wind", label: "WIND HIGH TO LOW", active: "WIND HIGH TO LOW", desc: true },
] as const;

type SortId = (typeof SORTS)[number]["id"];

function sortValue(item: Instrument, sort: SortId) {
  switch (sort) {
    case "risk": return item.reading.risk;
    case "humidity": return item.reading.humidity_pct;
    case "temp": return item.reading.temperature_c;
    case "wind": return item.reading.wind_kmh;
  }
}

function metric(value: number | null, digits: number, unit: string) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

export function InstrumentData({ onBack, engine }: { onBack: () => void; engine: Engine | null }) {
  const weather = useStore(app, (s) => s.weather);
  const day = useStore(app, (s) => s.forecastDay);
  const status = useStore(app, (s) => s.dataStatus);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const sim = useStore(app, (s) => s.simulation);
  const regions = useStore(app, (s) => s.regions);
  const theme = useStore(app, (s) => s.theme);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [province, setProvince] = useState<(typeof PROVINCES)[number]["id"] | null>(null);
  const [sort, setSort] = useState<SortId | null>("risk");
  const [sortDesc, setSortDesc] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const instruments = useMemo(() => {
    const points = sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
    const fires = buildFires(points, perimeters, weather, day, growth);
    return STATIONS.map((station) => ({ ...station, reading: readingAt(station, weather, day, fires, sim ? null : spread) }));
  }, [weather, day, hotspots, perimeters, spread, growth, sim, regions]);
  const error = status.weather === "error" && !weather.length
    ? `Weather unavailable${status.weatherError ? ` · ${status.weatherError}` : ""}`
    : null;

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let frame = 0;
    const tick = (time: number) => {
      const wave = (Math.cos((time / 1400) * Math.PI) + 1) / 2;
      const urgent = (Math.cos((time / 420) * Math.PI) + 1) / 2;
      const root = rootRef.current;
      root?.style.setProperty("--risk-blink", (0.38 + 0.62 * wave).toFixed(3));
      root?.style.setProperty("--risk-blink-urgent", (0.08 + 0.92 * urgent).toFixed(3));
      root?.style.setProperty("--risk-blink-bright", (1 + 0.85 * urgent).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const selected = selectedId ? instruments.find((item) => item.id === selectedId) ?? null : null;
  const where = selected ? coords(selected.latitude, selected.longitude) : null;
  const needle = query.trim().toLowerCase();
  const visible = [...instruments]
    .filter((item) => {
      const home = provinceOf(item.location);
      if (province && home !== province) return false;
      if (!needle) return true;
      const place = coords(item.latitude, item.longitude) ?? "";
      return [item.name, item.location, place, item.reading.label].some((part) => part.toLowerCase().includes(needle));
    })
    .sort((a, b) => {
      if (sort) {
        const av = sortValue(a, sort);
        const bv = sortValue(b, sort);
        if (av == null && bv == null) return a.name.localeCompare(b.name);
        if (av == null) return 1;
        if (bv == null) return -1;
        const delta = sortDesc ? bv - av : av - bv;
        if (delta !== 0) return delta;
        return a.name.localeCompare(b.name);
      }
      const order = PROVINCES.map((item) => item.id);
      const ai = order.indexOf((provinceOf(a.location) ?? "") as (typeof PROVINCES)[number]["id"]);
      const bi = order.indexOf((provinceOf(b.location) ?? "") as (typeof PROVINCES)[number]["id"]);
      const ar = ai === -1 ? -1 : ai;
      const br = bi === -1 ? -1 : bi;
      if (ar !== br) return ar - br;
      return a.name.localeCompare(b.name);
    });

  return (
    <div ref={rootRef} className="absolute inset-0 z-20 flex flex-col bg-void">
      <AppBar
        engine={engine}
        screen="instruments"
        onScreen={(next) => {
          if (next === "map") onBack();
        }}
        extra={
          <>
            <BarButton onClick={() => (selected ? setSelectedId(null) : onBack())}>Back</BarButton>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={`scroll-thin flex shrink-0 flex-col overflow-y-auto ${selected ? "w-80 border-r border-line" : "w-full"}`}>
          <div className="flex flex-wrap items-center gap-1 px-3 pt-3">
            <button
              type="button"
              onClick={() => setProvince(null)}
              className={`border px-2 py-1 text-[10px] tracking-[0.14em] transition ${province === null ? "border-phos text-phos" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"}`}
            >
              ALL
            </button>
            {PROVINCES.map((item) => {
              const on = province === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setProvince(item.id)}
                  className={`border px-2 py-1 text-[10px] tracking-[0.14em] transition ${on ? "border-phos text-phos" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"}`}
                >
                  {item.label}
                </button>
              );
            })}
            {Array.from({ length: FORECAST_DAYS + 1 }, (_, d) => (
              <button
                key={d}
                type="button"
                onClick={() => engine?.setForecastDay(d)}
                aria-pressed={d === day}
                className={`border px-2 py-1 text-[10px] tracking-[0.12em] transition ${d === day ? "border-phos text-phos" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"}`}
              >
                {dayLabel(d, weather[0]?.dates)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 px-3 py-3">
            {SORTS.map((item) => {
              const on = sort === item.id;
              const label = !on ? item.label : item.desc ? item.active : sortDesc ? "HUMIDITY HIGH TO LOW" : item.active;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (!on) {
                      setSort(item.id);
                      setSortDesc(item.desc);
                    } else if (!item.desc && !sortDesc) {
                      setSortDesc(true);
                    } else {
                      setSort(null);
                      setSortDesc(false);
                    }
                  }}
                  className={`border px-2 py-1 text-[10px] tracking-[0.12em] transition ${on ? "border-phos text-phos" : "border-line text-ink-dim hover:border-line-strong hover:text-ink"}`}
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setProvince(null);
                setQuery("");
                setSort(null);
                setSortDesc(false);
              }}
              className="border border-line px-2 py-1 text-[10px] tracking-[0.12em] text-ink-dim transition hover:border-line-strong hover:text-ink"
            >
              CLEAR FILTERS
            </button>
            <label className="ml-1 flex w-44 shrink-0 items-center gap-2 border border-line px-2 py-1">
              <Search size={12} className="shrink-0 text-ink-mute" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                aria-label="Search instruments"
                className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-mute"
              />
            </label>
          </div>
          {error && <p className="px-4 pb-3 text-[11px] text-fire">{error}</p>}
          {!error && !weather.length && <p className="px-4 pb-3 text-[11px] text-ink-mute">Loading weather…</p>}
          {!error && weather.length > 0 && visible.length === 0 && (
            <p className="px-4 pb-3 text-[11px] text-ink-mute">No matches.</p>
          )}
          <div className={selected ? "" : "grid sm:grid-cols-2 xl:grid-cols-3"}>
          {visible.map((item) => {
            const active = item.id === selectedId;
            const place = coords(item.latitude, item.longitude);
            const band = item.reading.fwi == null
              ? "—"
              : `${item.reading.fwi.toFixed(1)}${item.reading.category ? ` ${item.reading.category}` : ""}${item.reading.near ? ` · ${item.reading.near}` : ""}`;
            const tone = riskColor(item.reading.category);
            const alert = item.reading.category === "Extreme";
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`border border-line px-4 py-3 text-left transition hover:brightness-110 ${alert ? (selected ? "risk-blink" : "risk-blink-urgent") : ""}`}
                style={tone ? { borderColor: tone, background: `color-mix(in srgb, ${tone} ${active ? "22%" : "12%"}, transparent)`, boxShadow: `inset 3px 0 0 ${tone}` } : undefined}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[12px] tracking-wide text-ink">{item.name}</div>
                  <div className={`text-[10px] tracking-[0.14em] ${item.reading.ok ? "text-phos" : "text-ink-mute"}`}>{item.reading.label}</div>
                </div>
                <div className="mt-1 text-[11px] text-ink-dim">{item.location}</div>
                {place && <div className="mt-0.5 text-[10px] tracking-wide text-ink-mute">{place}</div>}
                {selected ? (
                  <div className="mt-2 text-[10px] tracking-[0.14em] text-ink-dim">
                    {item.reading.temperature_c != null ? `${item.reading.temperature_c.toFixed(1)}°C` : "—"}
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] tracking-[0.12em] sm:grid-cols-4">
                    <span><span className="text-ink-mute">TEMP </span>{metric(item.reading.temperature_c, 1, "°C")}</span>
                    <span><span className="text-ink-mute">HUM </span>{metric(item.reading.humidity_pct, 0, "%")}</span>
                    <span><span className="text-ink-mute">WIND </span>{metric(item.reading.wind_kmh, 0, " km/h")}</span>
                    <span style={tone ? { color: tone } : undefined}><span className="text-ink-mute">FWI </span>{band}</span>
                  </div>
                )}
              </button>
            );
          })}
          </div>
          <p className="mt-auto px-4 py-3 text-[10px] leading-relaxed text-ink-mute">
            Same weather, fire danger, and distance to fire as the map, for {dayLabel(day, weather[0]?.dates).toLowerCase()}.
          </p>
        </aside>
        {selected && (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <>
              <div className="border-b border-line px-4 py-3" style={riskColor(selected.reading.category) ? { borderColor: riskColor(selected.reading.category)! } : undefined}>
                <div className="text-[13px] tracking-wide text-ink">{selected.name}</div>
                <div className="mt-1 text-[11px] text-ink-dim">{selected.location}{where ? ` · ${where}` : ""}</div>
                <div className="mt-3 grid max-w-xl grid-cols-2 gap-x-6">
                  <KV k="SENSOR" v={selected.reading.label} accent={selected.reading.ok ? "var(--color-phos)" : undefined} />
                  <KV k="TEMP" v={metric(selected.reading.temperature_c, 1, "°C")} />
                  <KV k="HUMIDITY" v={metric(selected.reading.humidity_pct, 0, "%")} />
                  <KV k="WIND" v={metric(selected.reading.wind_kmh == null ? null : selected.reading.wind_kmh / 1.609344, 1, " mph")} />
                  <KV k="FOSBERG" v={selected.reading.ffwi == null ? "—" : `${selected.reading.ffwi.toFixed(0)}${selected.reading.category ? ` ${selected.reading.category}` : ""}`} accent={riskColor(selected.reading.category) ?? undefined} />
                  <KV k="NEAR" v={selected.reading.near ?? "No fire in reach"} accent={selected.reading.near ? riskColor(selected.reading.category) ?? undefined : undefined} />
                </div>
              </div>
              {selected.dashboard ? (
                <iframe title={selected.name} src={dashboardUrl(selected.dashboard, theme)} className="min-h-0 w-full flex-1 border-0 bg-white" />
              ) : (
                <div className="px-4 py-6 text-[11px] leading-relaxed text-ink-mute">
                  This station has no dashboard. The readings above are from the map weather.
                </div>
              )}
            </>
        </section>
        )}
      </div>
    </div>
  );
}
