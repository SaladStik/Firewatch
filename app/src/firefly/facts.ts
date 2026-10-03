/**
 * What Firefly knows: pure functions over a snapshot of app state, so every answer is grounded
 * in the same data the map shows. tools.ts builds the snapshot from app.get() and turns these
 * results into compact JSON for the ElevenLabs agent.
 */
import { communityThreats, type CommunityThreat } from "../data/communityRisk";
import type { Hotspot, Perimeter } from "../data/cwfis";
import type { FireGrowth } from "../data/fireHistory";
import { fireSources, type FireSource } from "../data/fireSpread";
import { isPerimeterActive, SIM_WEATHER_BOOST } from "../data/hazards";
import { weatherAt, type DayWeather, type WeatherGrid } from "../data/openMeteo";
import type { Place } from "../data/places";
import { project } from "../geo/projection";
import { growthLookup, type GrowthField } from "../world/fireGrowth";

export type FactPlace = Place & { region: number };

export interface FactsSnapshot {
  places: FactPlace[];
  /** Real hotspots plus simulated ones when the demo scenario is on (same as the map). */
  hotspots: Hotspot[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  forecastDay: number;
  simulation: boolean;
  spread: GrowthField | null;
  fireGrowth: Record<string, FireGrowth>;
  /** Workspace indices of the regions in focus. */
  focus: Set<number>;
  regionNames: string[];
  now: number;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Compass bearing of a world-km offset (+X east, +Z south). */
const bearing = (dx: number, dz: number) => COMPASS[Math.round((((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360) / 45) % 8];
const r1 = (n: number) => Math.round(n * 10) / 10;
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").trim();
const dateOf = (s: FactsSnapshot, d: number) => s.weather[0]?.dates[d] ?? `+${d}d`;

/** Edit distance, for "did you mean". */
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Best community for a spoken/typed name; landmarks only if nothing else matches. */
export function findPlace(places: FactPlace[], query: string): { place: FactPlace | null; suggestions: string[] } {
  const q = norm(query);
  if (!q) return { place: null, suggestions: [] };
  const ranked = [...places].sort((a, b) => Number(!!a.landmark) - Number(!!b.landmark) || b.pop - a.pop);
  const hit = ranked.find((p) => norm(p.name) === q) ?? ranked.find((p) => norm(p.name).startsWith(q)) ?? ranked.find((p) => norm(p.name).includes(q));
  if (hit) return { place: hit, suggestions: [] };
  const suggestions = ranked
    .filter((p) => !p.landmark)
    .map((p) => ({ name: p.name, d: lev(norm(p.name), q) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.name);
  return { place: null, suggestions };
}

/** Active fires (perimeters + hotspot clusters) with stable ids: perimeter id, or "cluster-<lat>,<lng>". */
export function activeFires(s: FactsSnapshot): (FireSource & { fid: string })[] {
  return fireSources(s.hotspots, s.perimeters, s.now, s.fireGrowth).map((f) => ({
    ...f, fid: f.id ?? `cluster-${f.lat.toFixed(2)},${f.lng.toFixed(2)}`,
  }));
}

function nearestPlace(s: FactsSnapshot, lat: number, lng: number) {
  const w = project(lat, lng);
  let best: { place: FactPlace; km: number; dir: string } | null = null;
  for (const p of s.places) {
    if (p.landmark) continue;
    const q = project(p.lat, p.lng);
    const km = Math.hypot(q.x - w.x, q.z - w.z);
    if (!best || km < best.km) best = { place: p, km, dir: bearing(w.x - q.x, w.z - q.z) };
  }
  return best;
}

/** "18 km W of Slave Lake" (the point is W of the town), or null. */
export function nearestPlaceText(s: FactsSnapshot, lat: number, lng: number): string | null {
  const n = nearestPlace(s, lat, lng);
  return n ? `${Math.round(n.km)} km ${n.dir} of ${n.place.name}` : null;
}

const dayView = (s: FactsSnapshot, d: DayWeather, i: number) => ({
  date: dateOf(s, i), danger: d.danger, fwi: r1(d.fwi), risk: r1(d.risk * 100),
  tempC: Math.round(d.temp), rhPct: Math.round(d.rh), windKmh: Math.round(d.wind), windFrom: COMPASS[Math.round((((d.windFrom % 360) + 360) % 360) / 45) % 8],
  rainMm: r1(d.rainMm), daysSinceRain: d.daysSinceRain,
});

export function threatsFor(s: FactsSnapshot, day: number): CommunityThreat[] {
  return communityThreats({
    places: s.places.filter((p) => !p.landmark && s.focus.has(p.region)),
    hotspots: s.hotspots, perimeters: s.perimeters, weather: s.weather, day,
    boost: s.simulation ? SIM_WEATHER_BOOST : 1, spread: s.spread, growth: s.fireGrowth, now: s.now,
  });
}

/** Distance (km) from a world point to the nearest active fire's edge. */
function nearestFire(s: FactsSnapshot, x: number, z: number) {
  return activeFires(s)
    .map((f) => ({ f, km: Math.max(0, Math.hypot(f.x - x, f.z - z) - f.r0) }))
    .sort((a, b) => a.km - b.km)[0];
}

export function placeReport(s: FactsSnapshot, p: FactPlace) {
  const cell = weatherAt(s.weather, p.lat, p.lng);
  const days = (cell?.days ?? []).map((d, i) => dayView(s, d, i));
  const byRisk = [...days].sort((a, b) => a.risk - b.risk);
  const w = project(p.lat, p.lng);
  const near = nearestFire(s, w.x, w.z);
  const burnDay = growthLookup(s.spread)(w.x, w.z);
  const threat = threatsFor(s, s.forecastDay).find((t) => t.place.name === p.name);
  return {
    place: p.name, population: p.pop, region: s.regionNames[p.region] ?? "",
    now: cell ? { tempC: Math.round(cell.now.temp), rhPct: Math.round(cell.now.rh), windKmh: Math.round(cell.now.wind) } : null,
    days,
    worstDay: byRisk[byRisk.length - 1] ?? null,
    bestDay: byRisk[0] ?? null,
    nearestFire: near && near.km < 150 ? { fire_id: near.f.fid, km: Math.round(near.km), direction: bearing(near.f.x - w.x, near.f.z - w.z) } : null,
    projectedSpreadReachesOnDay: burnDay >= 0 ? dateOf(s, burnDay) : null,
    threat: threat ? { score: r1(threat.score * 100), reason: threat.reason } : null,
    note: "Projected spread is a scenario model, not an official forecast.",
  };
}

export function briefing(s: FactsSnapshot) {
  const inFocus = (lat: number, lng: number) => {
    const n = nearestPlace(s, lat, lng);
    return !n || s.focus.has(n.place.region);
  };
  const hotspots24 = s.hotspots.filter((h) => s.now - Date.parse(h.time) < 86_400_000 && inFocus(h.lat, h.lng));
  const active = s.perimeters.filter((p) => isPerimeterActive(p, s.now) && (p.region === undefined || s.focus.has(p.region)));
  const biggest = [...active].sort((a, b) => b.areaHa - a.areaHa).slice(0, 3).map((p) => {
    const ring = p.rings[0] ?? [];
    const lng = ring.reduce((a, c) => a + c[0], 0) / Math.max(1, ring.length), lat = ring.reduce((a, c) => a + c[1], 0) / Math.max(1, ring.length);
    return { fire_id: p.id, hectares: Math.round(p.areaHa), near: nearestPlaceText(s, lat, lng) };
  });
  // Worst forecast day across the loaded regions (max risk over weather cells).
  let worst = { day: 0, risk: -1 };
  for (let d = 0; d < (s.weather[0]?.dates.length ?? 0); d++) {
    for (const g of s.weather) for (const c of g.cells) {
      const r = c.days[d]?.risk ?? 0;
      if (r > worst.risk) worst = { day: d, risk: r };
    }
  }
  return {
    regions: s.regionNames.filter((_, i) => s.focus.has(i)),
    simulation: s.simulation,
    activeFires: active.length, hotspotsLast24h: hotspots24.length, biggestFires: biggest,
    threatenedCommunities: threatsFor(s, s.forecastDay).slice(0, 5).map((t) => ({ place: t.place.name, reason: t.reason })),
    worstForecastDay: worst.risk >= 0 ? { date: dateOf(s, worst.day), peakRisk: r1(worst.risk * 100) } : null,
  };
}

export function fireList(s: FactsSnapshot) {
  return activeFires(s).slice(0, 12).map((f) => {
    const g = f.id ? s.fireGrowth[f.id] : undefined;
    return {
      fire_id: f.fid, kind: f.kind === "perimeter" ? "mapped perimeter" : "satellite hotspots",
      radiusKm: r1(f.r0), near: nearestPlaceText(s, f.lat, f.lng),
      recentGrowthKmPerDay: g ? r1(g.observedKmDay) : null,
    };
  });
}

/** Communities whose location the projected spread reaches, with the first day. */
export function townsInPath(s: FactsSnapshot) {
  const at = growthLookup(s.spread);
  return s.places
    .filter((p) => !p.landmark)
    .map((p) => { const w = project(p.lat, p.lng); return { p, d: at(w.x, w.z) }; })
    .filter((t) => t.d >= 0)
    .sort((a, b) => a.d - b.d || b.p.pop - a.p.pop)
    .map((t) => ({ place: t.p.name, lat: t.p.lat, lng: t.p.lng, population: t.p.pop, day: dateOf(s, t.d) }));
}

export function explainAt(s: FactsSnapshot, lat: number, lng: number, hex: { landLabel: string; fuel: number; statusLabel: string; risk: number } | null) {
  const d = weatherAt(s.weather, lat, lng)?.days[s.forecastDay];
  const w = project(lat, lng);
  const near = nearestFire(s, w.x, w.z);
  const burnDay = growthLookup(s.spread)(w.x, w.z);
  return {
    date: dateOf(s, s.forecastDay),
    hex: hex ? { land: hex.landLabel, fuelLoadPct: Math.round(hex.fuel * 100), status: hex.statusLabel, riskIndex: Math.round(hex.risk * 100) } : null,
    fireWeather: d ? { danger: d.danger, fwi: r1(d.fwi), isi: r1(d.isi), bui: r1(d.bui), ffmc: r1(d.ffmc), weatherRisk: Math.round(d.risk * 100), windKmh: Math.round(d.wind), daysSinceRain: d.daysSinceRain } : null,
    nearestFireKm: near ? Math.round(near.km) : null,
    projectedSpreadReachesOnDay: burnDay >= 0 ? dateOf(s, burnDay) : null,
    howScored: "risk = Canadian FWI fire danger × fuel load of the land cover, raised near fires (wind-shaped); fires and perimeters override.",
  };
}

/**
 * Crew allocation: rank fires by threat to communities (population near or in the projected path,
 * closer = worse) plus growth (observed km/day, or size when unknown). Returns the top `crews`.
 */
export function crewRanking(s: FactsSnapshot, crews: number) {
  const at = growthLookup(s.spread);
  const ranked = activeFires(s).map((f) => {
    const reasons: string[] = [];
    let exposure = 0;
    for (const p of s.places) {
      if (p.landmark) continue;
      const q = project(p.lat, p.lng);
      const km = Math.max(0, Math.hypot(q.x - f.x, q.z - f.z) - f.r0);
      const inPath = at(q.x, q.z) >= 0 && km < 120;
      if (km > 60 && !inPath) continue;
      const w = (inPath ? 1 : 0.5) * Math.max(0, 1 - (km / 60) * (inPath ? 0.5 : 1));
      exposure += w * Math.log10(10 + p.pop);
      if (w > 0.3) reasons.push(`${p.name} (${p.pop.toLocaleString("en-CA")} people) ${Math.round(km)} km away${inPath ? ", in projected path" : ""}`);
    }
    const g = f.id ? s.fireGrowth[f.id] : undefined;
    const growthKm = g ? g.observedKmDay : f.r0 * 0.2;
    if (g) reasons.push(`growing ~${r1(g.observedKmDay)} km/day`);
    const score = exposure * 2 + growthKm + f.r0 * 0.3;
    return { fire_id: f.fid, lat: r1(f.lat), lng: r1(f.lng), near: nearestPlaceText(s, f.lat, f.lng), score: r1(score), reasons: reasons.slice(0, 3) };
  });
  return ranked.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(10, crews)));
}
