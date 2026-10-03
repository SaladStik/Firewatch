/** A small snapshot of the map for the brain. Built from state already in the app. */
import type { Engine } from "../engine";
import { communityThreats } from "../data/communityRisk";
import { isPerimeterActive, simulatedHotspots } from "../data/hazards";
import type { Hotspot, Perimeter } from "../data/cwfis";
import { app } from "../state/app";
import type { Brief, BriefFire, BriefThreat } from "./types";

/** Same cutoff as the forecast bar: smaller places stay off the threat list. */
const MIN_POP = 200;

function localIso(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

function ringCenter(ring: [number, number][]): { lat: number; lng: number } {
  let lat = 0;
  let lng = 0;
  for (const [lo, la] of ring) {
    lng += lo;
    lat += la;
  }
  const n = Math.max(1, ring.length);
  return { lat: lat / n, lng: lng / n };
}

/** Satellite hotspots only. Demo ignitions and demo instrument stations are not communities-at-risk inputs. */
function liveHotspots(): Hotspot[] {
  return app.get().hotspots.filter((h) => h.agency !== "SIMULATION");
}

function hotspotsForFires(): Hotspot[] {
  const s = app.get();
  if (!s.simulation) return s.hotspots;
  const sims = s.regions.flatMap((r) => simulatedHotspots(r.demoSites));
  return [...s.hotspots, ...sims];
}

/** Communities at risk for the current forecast day, same rules as the forecast bar. */
export function threatList(): BriefThreat[] {
  const s = app.get();
  const focus = new Set(s.focus.map((id) => s.regions.findIndex((r) => r.id === id)).filter((i) => i >= 0));
  const rows = communityThreats({
    places: s.places.filter((p) => !p.landmark && p.pop >= MIN_POP && focus.has(p.region)),
    hotspots: liveHotspots(),
    perimeters: s.perimeters,
    weather: s.weather,
    day: s.forecastDay,
    boost: 1,
    spread: s.simulation ? null : s.spread,
    growth: s.fireGrowth,
  });
  return rows.map((t) => ({ name: t.place.name, reason: t.reason, lat: t.place.lat, lng: t.place.lng }));
}

/** Reason for one place, or null when it would not be listed. */
export function threatReasonAt(place: { name: string; lat: number; lng: number; pop: number; region: number }): string | null {
  const s = app.get();
  const [row] = communityThreats({
    places: [{ ...place, landmark: false }],
    hotspots: liveHotspots(),
    perimeters: s.perimeters,
    weather: s.weather,
    day: s.forecastDay,
    boost: 1,
    spread: s.simulation ? null : s.spread,
    growth: s.fireGrowth,
  });
  return row?.reason ?? null;
}

/** Active perimeters by area, then hotspots. */
export function fireList(): BriefFire[] {
  const s = app.get();
  const now = Date.now();
  const perimeters = s.perimeters
    .filter((p) => isPerimeterActive(p, now) && (p.rings[0]?.length ?? 0) > 0)
    .sort((a, b) => b.areaHa - a.areaHa);
  const fires: BriefFire[] = perimeters.map((p: Perimeter) => {
    const at = ringCenter(p.rings[0]);
    return {
      id: p.id,
      kind: "perimeter",
      lat: at.lat,
      lng: at.lng,
      areaHa: p.areaHa,
      label: `${Math.round(p.areaHa).toLocaleString()} ha`,
    };
  });
  for (const h of hotspotsForFires()) {
    fires.push({
      id: h.id,
      kind: "hotspot",
      lat: h.lat,
      lng: h.lng,
      areaHa: null,
      label: h.agency === "SIMULATION" ? "Simulated hotspot" : "Hotspot",
    });
  }
  return fires;
}

export function buildBrief(engine: Engine | null): Brief {
  const s = app.get();
  const focus = new Set(s.focus.map((id) => s.regions.findIndex((r) => r.id === id)).filter((i) => i >= 0));
  const here = engine?.scene ? engine.scene.targetLatLng() : null;
  return {
    focusIds: [...s.focus],
    regions: s.regions.map((r, index) => ({ id: r.id, name: r.name, code: r.code, index })),
    forecastDay: s.forecastDay,
    today: s.weather[0]?.dates[0] || localIso(),
    layers: s.layers,
    simulation: s.simulation,
    dataStatus: { cwfis: s.dataStatus.cwfis, weather: s.dataStatus.weather },
    places: s.places.map((p) => ({
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      pop: p.pop,
      regionId: s.regions[p.region]?.id ?? "",
      regionIndex: p.region,
      landmark: !!p.landmark,
      focused: focus.has(p.region),
    })),
    fires: fireList(),
    threats: threatList(),
    here,
    selected: s.selected ? { lat: s.selected.lat, lng: s.selected.lng } : null,
  };
}
