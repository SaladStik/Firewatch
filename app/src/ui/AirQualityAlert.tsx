/**
 * Air-quality reading for the hex under the pointer (or the clicked selection),
 * plus a short list of other smoke-advised communities. Estimate only.
 */
import { useMemo } from "react";
import { MapPin, Wind } from "lucide-react";
import { airAt } from "../data/airQuality";
import { simulatedHotspots } from "../data/hazards";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";

const MAX_SHOWN = 2;
const HAZE = "#6b5a4a";
const PLACE_NEAR = 0.03;

function levelColor(level: string) {
  if (level === "Extreme") return "var(--color-fire)";
  if (level === "Very High") return "var(--color-risk-ext)";
  if (level === "High") return "var(--color-risk-high)";
  if (level === "Good") return "var(--color-phos)";
  return "var(--color-risk-elev)";
}

export function AirQualityAlert({ engine }: { engine: Engine | null }) {
  const on = useStore(app, (s) => s.layers.air);
  const atRisk = useStore(app, (s) => s.airThreats);
  const selected = useStore(app, (s) => s.selected);
  const hover = useStore(app, (s) => s.hover);
  const places = useStore(app, (s) => s.places);
  const day = useStore(app, (s) => s.forecastDay);
  const weather = useStore(app, (s) => s.weather);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const spread = useStore(app, (s) => s.spread);
  const growth = useStore(app, (s) => s.fireGrowth);
  const sim = useStore(app, (s) => s.simulation);
  const regions = useStore(app, (s) => s.regions);

  const focus = selected ?? hover;
  const lat = focus?.lat;
  const lng = focus?.lng;

  const here = useMemo(() => {
    if (lat == null || lng == null) return null;
    const fires = sim
      ? [...hotspots, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))]
      : hotspots.filter((h) => h.agency !== "SIMULATION");
    const reading = airAt(lat, lng, {
      hotspots: fires,
      perimeters,
      weather,
      day,
      spread,
      growth,
    });
    let label = `${reading.lat.toFixed(2)}°, ${reading.lng.toFixed(2)}°`;
    let best = PLACE_NEAR;
    for (const p of places) {
      if (p.landmark) continue;
      const d = Math.hypot(p.lat - reading.lat, p.lng - reading.lng);
      if (d < best) {
        best = d;
        label = p.name;
      }
    }
    return { ...reading, label, pinned: !!selected };
  }, [lat, lng, places, hotspots, perimeters, weather, day, spread, growth, sim, regions, selected]);

  if (!on) return null;
  if (!here && !atRisk.length) return null;

  const others = atRisk.filter((t) => {
    if (!here) return true;
    return Math.hypot(t.place.lat - here.lat, t.place.lng - here.lng) > PLACE_NEAR;
  });

  return (
    <div
      className="panel hud-strip pointer-events-auto flex items-center"
      style={{ borderColor: `${HAZE}66` }}
      title="Smoke estimate, not official AQHI"
    >
      <span className="label-xs flex shrink-0 items-center gap-1" style={{ color: HAZE }}>
        <Wind size={10} />
        Air
      </span>
      <div className="scroll-thin flex min-w-0 gap-1 overflow-x-auto">
        {here && (
          <button
            type="button"
            onClick={() => engine?.flyToLatLng(here.lat, here.lng, 20)}
            title={`${here.pinned ? "Selected" : "Under pointer"} · AQHI ~${here.aqhi} · ${here.level} · ${here.reason}`}
            className="hud-chip shrink-0"
            style={{ borderColor: HAZE, background: `${HAZE}18`, color: "var(--color-ink)" }}
          >
            <MapPin size={9} className="mr-0.5 inline align-[-1px]" />
            {here.label}
            <span style={{ color: levelColor(here.level) }}> · {here.level}</span>
            <span className="text-ink-mute"> · {here.reason}</span>
          </button>
        )}
        {others.slice(0, MAX_SHOWN).map((t) => (
          <button
            key={`${t.place.region}-${t.place.name}-${t.place.lat}`}
            onClick={() => engine?.flyToLatLng(t.place.lat, t.place.lng, 25)}
            title={`AQHI ~${t.aqhi} · ${t.level} · ${t.reason}`}
            className="hud-chip shrink-0"
            style={{ borderColor: `${HAZE}55` }}
          >
            {t.place.name}
            <span style={{ color: levelColor(t.level) }}> · {t.level}</span>
          </button>
        ))}
        {others.length > MAX_SHOWN && (
          <span className="shrink-0 self-center text-[9px] text-ink-mute">+{others.length - MAX_SHOWN}</span>
        )}
      </div>
    </div>
  );
}
