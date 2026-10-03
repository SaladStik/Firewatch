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
import { project, unproject } from "../geo/projection";
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

/**
 * Active fires in the focus regions (perimeters + hotspot clusters), with stable ids: perimeter id,
 * or "cluster-<lat>,<lng>". A fire belongs to the region of its nearest community.
 */
export function activeFires(s: FactsSnapshot): (FireSource & { fid: string })[] {
  return fireSources(s.hotspots, s.perimeters, s.now, s.fireGrowth)
    .filter((f) => { const n = nearestPlace(s, f.lat, f.lng); return !n || s.focus.has(n.place.region); })
    .map((f) => ({ ...f, fid: f.id ?? `cluster-${f.lat.toFixed(2)},${f.lng.toFixed(2)}` }));
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
  const centroid = (p: Perimeter) => {
    const ring = p.rings[0] ?? [];
    return { lng: ring.reduce((a, c) => a + c[0], 0) / Math.max(1, ring.length), lat: ring.reduce((a, c) => a + c[1], 0) / Math.max(1, ring.length) };
  };
  const active = s.perimeters.filter((p) => { const c = centroid(p); return isPerimeterActive(p, s.now) && inFocus(c.lat, c.lng); });
  const biggest = [...active].sort((a, b) => b.areaHa - a.areaHa).slice(0, 3).map((p) => {
    const c = centroid(p);
    return { fire_id: p.id, hectares: Math.round(p.areaHa), near: nearestPlaceText(s, c.lat, c.lng) };
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
    activeFires: activeFires(s).length, activePerimeters: active.length, hotspotsLast24h: hotspots24.length, biggestFires: biggest,
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

/** Risk sampled on a grid of world points (engine.riskScan), row-major from (x0, z0). */
export interface RiskGrid { x0: number; z0: number; step: number; nx: number; nz: number; risk: Float32Array }

/** Map colour thresholds (hex/nodeTypes statusForRisk): High danger and up, Extreme. */
const HIGH_RISK = 0.68, EXTREME_RISK = 0.85;

/**
 * The map's danger zones: connected areas at High danger or worse, biggest and worst first. They
 * have no names, so each is described by its nearest town, size, peak, and what drives it.
 */
export function riskZones(s: FactsSnapshot, g: RiskGrid, max = 5) {
  const seen = new Uint8Array(g.nx * g.nz);
  const zones: { cells: number; extreme: number; peak: number; px: number; pz: number; sx: number; sz: number; w: number }[] = [];
  for (let start = 0; start < g.risk.length; start++) {
    if (seen[start] || g.risk[start] < HIGH_RISK) continue;
    const z = { cells: 0, extreme: 0, peak: 0, px: 0, pz: 0, sx: 0, sz: 0, w: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % g.nx, j = (k - i) / g.nx, r = g.risk[k];
      const x = g.x0 + i * g.step, wz = g.z0 + j * g.step;
      z.cells++;
      if (r >= EXTREME_RISK) z.extreme++;
      if (r > z.peak) { z.peak = r; z.px = x; z.pz = wz; }
      z.sx += x * r; z.sz += wz * r; z.w += r;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, nk = nj * g.nx + ni;
        if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz || seen[nk] || g.risk[nk] < HIGH_RISK) continue;
        seen[nk] = 1;
        stack.push(nk);
      }
    }
    zones.push(z);
  }
  const cellKm2 = g.step * g.step;
  const inFocus = (z: (typeof zones)[number]) => {
    const { lat, lng } = unproject(z.sx / z.w, z.sz / z.w);
    const n = nearestPlace(s, lat, lng);
    return !n || s.focus.has(n.place.region);
  };
  return zones
    .filter(inFocus)
    .map((z) => ({ z, score: z.peak * Math.sqrt(z.cells * cellKm2) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ z }, n) => {
      const cx = z.sx / z.w, cz = z.sz / z.w;
      const { lat, lng } = unproject(cx, cz);
      const areaKm2 = z.cells * cellKm2;
      const acrossKm = 2 * Math.sqrt(areaKm2 / Math.PI);
      const fire = nearestFire(s, cx, cz);
      const fireDriven = !!fire && fire.km < acrossKm / 2 + 10;
      return {
        zone: n + 1,
        danger: z.peak >= EXTREME_RISK ? "Extreme" : "High",
        peakRisk: Math.round(z.peak * 100),
        areaKm2: Math.round(areaKm2),
        extremeKm2: Math.round(z.extreme * cellKm2),
        acrossKm: Math.round(acrossKm),
        lat: r1(lat), lng: r1(lng),
        near: nearestPlaceText(s, lat, lng),
        nearestFire: fire ? { fire_id: fire.f.fid, km: Math.round(fire.km) } : null,
        cause: fireDriven
          ? "around an active fire: the fire's wind-driven reach on top of the day's fire weather"
          : "fire weather on dry fuel (heat, low humidity, wind, days since rain)",
      };
    });
}
