/**
 * What Firefly knows: pure functions over a snapshot of app state, so every answer is grounded
 * in the same data the map shows. tools.ts builds the snapshot from app.get() and turns these
 * results into compact JSON for the ElevenLabs agent.
 */
import { communityThreats, type CommunityThreat } from "../data/communityRisk";
import type { Hotspot, Perimeter } from "../data/cwfis";
import type { FireGrowth } from "../data/fireHistory";
import { fireSources, type FireSource } from "../data/fireSpread";
import { SIM_WEATHER_BOOST } from "../data/hazards";
import { weatherAt, type DayWeather, type WeatherGrid } from "../data/openMeteo";
import type { Place } from "../data/places";
import { STAGE_LABEL, STAGES, type ReportedFire, type StageOfControl } from "../data/reportedFires";
import { project, unproject } from "../geo/projection";
import { hexToWorld } from "../hex/hexMath";
import { growthLookup, type GrowthField } from "../world/fireGrowth";

export type FactPlace = Place & { region: number };

export interface FactsSnapshot {
  places: FactPlace[];
  /** Real hotspots plus simulated ones when the demo scenario is on (same as the map). */
  hotspots: Hotspot[];
  perimeters: Perimeter[];
  /** Agency-reported fires, the source of truth for active wildfires. */
  reported: ReportedFire[];
  /** False when the official fire list could not be fetched (it may be stale or empty). */
  reportedOk: boolean;
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

/** Said with every answer that mentions hotspots. */
export const HEAT_NOTE = "Satellite hotspots are unconfirmed heat detections (often farm or controlled burns). Only fire agencies confirm wildfires.";

/** In a focus region: its tagged region, else the region of its nearest community. */
function inFocus(s: FactsSnapshot, lat: number, lng: number, region?: number) {
  if (region != null) return s.focus.has(region);
  const n = nearestPlace(s, lat, lng);
  return !n || s.focus.has(n.place.region);
}

export interface ActiveFire {
  /** National fire id, or "sim-<lat>,<lng>" for a demo fire. */
  fid: string;
  /** The agency's fire number. */
  name: string;
  agency: string;
  stage: StageOfControl;
  lat: number; lng: number; x: number; z: number;
  /** Radius (km) of a circle with the reported area. */
  r0: number;
  sizeHa: number;
  simulated: boolean;
  /** Workspace index of its region. */
  region?: number;
  /** Active CWFIS perimeter this fire sits in, for its growth history. */
  perimeterId?: string;
}

const AGENCY_NAMES: Record<string, string> = {
  AB: "Alberta Wildfire", BC: "BC Wildfire Service", SK: "Saskatchewan Public Safety Agency", PC: "Parks Canada (national parks)",
};
const agencyName = (code: string) => AGENCY_NAMES[code] ?? code;

const radiusKm = (ha: number) => Math.sqrt(ha / 100 / Math.PI);

/**
 * Active wildfires in the focus regions: agency-reported fires that aren't extinguished. In the
 * demo scenario the simulated ignitions count too (out of control, flagged simulated).
 */
export function activeFires(s: FactsSnapshot): ActiveFire[] {
  const perims = fireSources([], s.perimeters, s.now);
  const official = s.reported.filter((f) => inFocus(s, f.lat, f.lng, f.region)).map((f): ActiveFire => {
    const w = project(f.lat, f.lng);
    const perim = perims.find((p) => Math.hypot(p.x - w.x, p.z - w.z) <= p.r0 + 2);
    return { fid: f.id, name: f.name, agency: f.agency, stage: f.stage, lat: f.lat, lng: f.lng, ...w, r0: radiusKm(f.sizeHa), sizeHa: f.sizeHa, simulated: false,
      region: f.region ?? nearestPlace(s, f.lat, f.lng)?.place.region, perimeterId: perim?.id };
  });
  const sims = fireSources(s.hotspots.filter((h) => h.agency === "SIMULATION"), [], s.now)
    .filter((f) => inFocus(s, f.lat, f.lng))
    .map((f): ActiveFire => ({
      fid: `sim-${f.lat.toFixed(2)},${f.lng.toFixed(2)}`, name: "simulated fire", agency: "SIMULATION", stage: "out_of_control",
      lat: f.lat, lng: f.lng, x: f.x, z: f.z, r0: f.r0, sizeHa: Math.round(Math.PI * f.r0 * f.r0 * 100), simulated: true,
    }));
  return [...official, ...sims];
}

export interface HeatDetection extends FireSource {
  /** Perimeter id, or "heat-<lat>,<lng>" for a hotspot cluster. */
  fid: string;
  hotspots: number;
  maxFrpMw: number;
  /** Share of its hotspots CWFIS puts on farmland. */
  farmShare: number;
  /** Official fire it belongs to (within a few km), if any. */
  officialFire: string | null;
  likelyFarmOrControlledBurn: boolean;
}

/** A cluster this weak and mostly on farmland is most likely a stubble or slash burn. */
const FARM_SHARE = 0.5, FARM_MAX_FRP_MW = 25;

/**
 * Satellite heat in the focus regions (real hotspots only): active CWFIS perimeters and hotspot
 * clusters, each with its hotspot count, strongest FRP and farmland share.
 */
export function heatDetections(s: FactsSnapshot): HeatDetection[] {
  const real = s.hotspots.filter((h) => h.agency !== "SIMULATION");
  const fires = activeFires(s).filter((f) => !f.simulated);
  const pts = real.map((h) => ({ h, ...project(h.lat, h.lng) }));
  return fireSources(real, s.perimeters, s.now, s.fireGrowth)
    .filter((f) => inFocus(s, f.lat, f.lng))
    .map((f) => {
      const mine = pts.filter((p) => Math.hypot(p.x - f.x, p.z - f.z) <= f.r0 + 1).map((p) => p.h);
      const farmShare = mine.length ? mine.filter((h) => h.fuel.toLowerCase() === "farm").length / mine.length : 0;
      const maxFrpMw = mine.reduce((m, h) => Math.max(m, h.frp || 0), 0);
      const official = fires.find((o) => Math.hypot(o.x - f.x, o.z - f.z) <= o.r0 + f.r0 + 5);
      return {
        ...f, fid: f.id ?? `heat-${f.lat.toFixed(2)},${f.lng.toFixed(2)}`,
        hotspots: mine.length, maxFrpMw: r1(maxFrpMw), farmShare: r1(farmShare), officialFire: official?.fid ?? null,
        likelyFarmOrControlledBurn: !official && f.kind === "hotspots" && farmShare >= FARM_SHARE && maxFrpMw < FARM_MAX_FRP_MW,
      };
    });
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

/** Nearest of `items` to a world point, by distance (km) to its edge. */
function nearestOf<T extends { x: number; z: number; r0: number }>(items: T[], x: number, z: number) {
  return items
    .map((f) => ({ f, km: Math.max(0, Math.hypot(f.x - x, f.z - z) - f.r0) }))
    .sort((a, b) => a.km - b.km)[0];
}
const nearestFire = (s: FactsSnapshot, x: number, z: number) => nearestOf(activeFires(s), x, z);
const nearestHeat = (s: FactsSnapshot, x: number, z: number) => nearestOf(heatDetections(s), x, z);

export function placeReport(s: FactsSnapshot, p: FactPlace) {
  const cell = weatherAt(s.weather, p.lat, p.lng);
  const days = (cell?.days ?? []).map((d, i) => dayView(s, d, i));
  const byRisk = [...days].sort((a, b) => a.risk - b.risk);
  const w = project(p.lat, p.lng);
  const near = nearestFire(s, w.x, w.z);
  const heat = nearestHeat(s, w.x, w.z);
  const burnDay = growthLookup(s.spread)(w.x, w.z);
  const threat = threatsFor(s, s.forecastDay).find((t) => t.place.name === p.name);
  return {
    place: p.name, population: p.pop, region: s.regionNames[p.region] ?? "",
    now: cell ? { tempC: Math.round(cell.now.temp), rhPct: Math.round(cell.now.rh), windKmh: Math.round(cell.now.wind) } : null,
    days,
    worstDay: byRisk[byRisk.length - 1] ?? null,
    bestDay: byRisk[0] ?? null,
    nearestFire: near && near.km < 150 ? { fire_id: near.f.fid, stage: STAGE_LABEL[near.f.stage], km: Math.round(near.km), direction: bearing(near.f.x - w.x, near.f.z - w.z) } : null,
    nearestHeatDetection: heat && heat.km < 150
      ? { id: heat.f.fid, km: Math.round(heat.km), direction: bearing(heat.f.x - w.x, heat.f.z - w.z), likelyFarmOrControlledBurn: heat.f.likelyFarmOrControlledBurn }
      : null,
    projectedSpreadReachesOnDay: burnDay >= 0 ? dateOf(s, burnDay) : null,
    threat: threat ? { score: r1(threat.score * 100), reason: threat.reason } : null,
    note: `Projected spread is a scenario model, not an official forecast. ${HEAT_NOTE}`,
  };
}

/** Official fires per stage of control, with total hectares. */
function byStage(fires: ActiveFire[]) {
  const out = {} as Record<"outOfControl" | "beingHeld" | "underControl", { count: number; hectares: number }>;
  const key = { out_of_control: "outOfControl", being_held: "beingHeld", under_control: "underControl" } as const;
  for (const st of STAGES) {
    const f = fires.filter((x) => x.stage === st);
    out[key[st]] = { count: f.length, hectares: Math.round(f.reduce((a, x) => a + x.sizeHa, 0)) };
  }
  return out;
}

export function briefing(s: FactsSnapshot) {
  const hotspots24 = s.hotspots.filter((h) => h.agency !== "SIMULATION" && s.now - Date.parse(h.time) < 86_400_000 && inFocus(s, h.lat, h.lng, h.region));
  const fires = activeFires(s);
  const heat = heatDetections(s);
  const official = fires.filter((f) => !f.simulated);
  const biggest = [...fires].sort((a, b) => b.sizeHa - a.sizeHa).slice(0, 3).map((f) => ({
    fire_id: f.fid, stage: STAGE_LABEL[f.stage], hectares: Math.round(f.sizeHa), near: nearestPlaceText(s, f.lat, f.lng), ...(f.simulated ? { simulated: true } : {}),
  }));
  // Per province, and who reported them: a park's fires come from Parks Canada, not the province.
  const byRegion = [...s.focus].map((i) => {
    const here = official.filter((f) => f.region === i);
    const agencies: Record<string, number> = {};
    for (const f of here) agencies[agencyName(f.agency)] = (agencies[agencyName(f.agency)] ?? 0) + 1;
    return { region: s.regionNames[i] ?? "", ...byStage(here), reportedBy: agencies };
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
    officialWildfires: {
      source: "fire agencies (Natural Resources Canada national fire list, same as CIFFC)",
      ...(s.reportedOk ? {} : { warning: "The official fire list could not be refreshed; these counts may be out of date." }),
      total: official.length, ...byStage(official), byRegion,
    },
    ...(s.simulation ? { simulatedFires: fires.length - official.length } : {}),
    biggestFires: biggest,
    heatDetections: {
      hotspotsLast24h: hotspots24.length,
      clusters: heat.filter((h) => h.kind === "hotspots").length,
      likelyFarmOrControlledBurns: heat.filter((h) => h.likelyFarmOrControlledBurn).length,
      atOfficialFires: heat.filter((h) => h.officialFire).length,
      activeMappedPerimeters: heat.filter((h) => h.kind === "perimeter").length,
      note: HEAT_NOTE,
    },
    threatenedCommunities: threatsFor(s, s.forecastDay).slice(0, 5).map((t) => ({ place: t.place.name, reason: t.reason })),
    worstForecastDay: worst.risk >= 0 ? { date: dateOf(s, worst.day), peakRisk: r1(worst.risk * 100) } : null,
  };
}

const growthOf = (s: FactsSnapshot, f: ActiveFire) => (f.perimeterId ? s.fireGrowth[f.perimeterId] : undefined);

export function fireView(s: FactsSnapshot, f: ActiveFire) {
  const g = growthOf(s, f);
  return {
    fire_id: f.fid, agencyFireNumber: f.name, reportedBy: agencyName(f.agency), stage: STAGE_LABEL[f.stage], hectares: Math.round(f.sizeHa),
    near: nearestPlaceText(s, f.lat, f.lng), recentGrowthKmPerDay: g ? r1(g.observedKmDay) : null,
    ...(f.simulated ? { simulated: true } : {}),
  };
}

export function heatView(s: FactsSnapshot, h: HeatDetection) {
  return {
    id: h.fid, kind: h.kind === "perimeter" ? "satellite-mapped burn area" : "satellite hotspot cluster",
    hotspots: h.hotspots, maxFrpMw: h.maxFrpMw, farmlandPct: Math.round(h.farmShare * 100),
    near: nearestPlaceText(s, h.lat, h.lng), atOfficialFire: h.officialFire,
    likelyFarmOrControlledBurn: h.likelyFarmOrControlledBurn,
  };
}

const STAGE_ORDER: Record<StageOfControl, number> = { out_of_control: 0, being_held: 1, under_control: 2 };

/** Active fires, worst stage then biggest first. */
export const rankedFires = (s: FactsSnapshot) => activeFires(s).sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || b.sizeHa - a.sizeHa);

/** Official fires (worst stage, then biggest first) and, separately, unconfirmed heat detections. */
export function fireList(s: FactsSnapshot) {
  const fires = rankedFires(s);
  // Heat not already at an official fire, likely wildfire-looking ones first.
  const heat = heatDetections(s).filter((h) => !h.officialFire).sort((a, b) => Number(a.likelyFarmOrControlledBurn) - Number(b.likelyFarmOrControlledBurn) || b.hotspots - a.hotspots);
  return {
    officialFires: fires.slice(0, 12).map((f) => fireView(s, f)),
    officialTotal: fires.length,
    ...(s.reportedOk ? {} : { warning: "The official fire list could not be refreshed; it may be out of date." }),
    heatDetections: heat.slice(0, 8).map((h) => heatView(s, h)),
    heatDetectionsTotal: heat.length,
    note: HEAT_NOTE,
  };
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
  const heat = nearestHeat(s, w.x, w.z);
  const burnDay = growthLookup(s.spread)(w.x, w.z);
  return {
    date: dateOf(s, s.forecastDay),
    hex: hex ? { land: hex.landLabel, fuelLoadPct: Math.round(hex.fuel * 100), status: hex.statusLabel, riskIndex: Math.round(hex.risk * 100) } : null,
    fireWeather: d ? { danger: d.danger, fwi: r1(d.fwi), isi: r1(d.isi), bui: r1(d.bui), ffmc: r1(d.ffmc), weatherRisk: Math.round(d.risk * 100), windKmh: Math.round(d.wind), daysSinceRain: d.daysSinceRain } : null,
    nearestFireKm: near ? Math.round(near.km) : null,
    nearestHeatDetectionKm: heat ? Math.round(heat.km) : null,
    projectedSpreadReachesOnDay: burnDay >= 0 ? dateOf(s, burnDay) : null,
    howScored: "risk = Canadian FWI fire danger × fuel load of the land cover, raised near satellite hotspots (wind-shaped); official out-of-control fires and active perimeters override.",
    note: HEAT_NOTE,
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
    const g = growthOf(s, f);
    const growthKm = g ? g.observedKmDay : f.r0 * 0.2;
    if (g) reasons.push(`growing ~${r1(g.observedKmDay)} km/day`);
    // Out-of-control fires need crews most; held and controlled ones much less.
    const score = (exposure * 2 + growthKm + f.r0 * 0.3) * (f.stage === "out_of_control" ? 1 : f.stage === "being_held" ? 0.6 : 0.3);
    return {
      fire_id: f.fid, stage: STAGE_LABEL[f.stage], hectares: Math.round(f.sizeHa), lat: r1(f.lat), lng: r1(f.lng),
      near: nearestPlaceText(s, f.lat, f.lng), score: r1(score), reasons: reasons.slice(0, 3), ...(f.simulated ? { simulated: true } : {}),
    };
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
      // The map's boost comes from hotspots, so a zone around heat is driven by it.
      const heat = nearestHeat(s, cx, cz);
      const heatDriven = !!heat && heat.km < acrossKm / 2 + 10;
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
        nearestFire: fire ? { fire_id: fire.f.fid, stage: STAGE_LABEL[fire.f.stage], km: Math.round(fire.km) } : null,
        cause: fireDriven
          ? "around a reported wildfire: its wind-driven reach on top of the day's fire weather"
          : heatDriven
            ? `around satellite heat detections${heat.f.likelyFarmOrControlledBurn ? " that look like farm or controlled burns" : ""} (unconfirmed): the map raises risk downwind of them on top of the day's fire weather`
            : "fire weather on dry fuel (heat, low humidity, wind, days since rain)",
      };
    });
}

/** Where a fire's projected burn heads (cells within 150 km): compass direction and furthest reach. */
export function spreadHeading(s: FactsSnapshot, fire: { x: number; z: number }) {
  const f = s.spread;
  if (!f?.cells.length) return null;
  let sx = 0, sz = 0, n = 0, far = 0;
  for (let i = 0; i < f.cells.length; i += 3) {
    const p = hexToWorld(f.cells[i], f.cells[i + 1], f.size);
    const dx = p.x - fire.x, dz = p.z - fire.z, d = Math.hypot(dx, dz);
    if (d > 150) continue;
    sx += dx; sz += dz; n++;
    far = Math.max(far, d);
  }
  if (!n) return null;
  const mx = sx / n, mz = sz / n;
  return { headsToward: Math.hypot(mx, mz) < 0.5 ? "all directions (no clear lean)" : bearing(mx, mz), reachKm: r1(far) };
}

/** The wind at a point for each forecast day up to `day`: where it blows from and toward, km/h. */
export function windByDay(s: FactsSnapshot, lat: number, lng: number, day: number) {
  const cell = weatherAt(s.weather, lat, lng);
  if (!cell) return [];
  const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  return cell.days.slice(0, day + 1).map((d, i) => ({
    date: dateOf(s, i), from: compass(d.windFrom), toward: compass(d.windFrom + 180), kmh: Math.round(d.windNoon ?? d.wind),
  }));
}
