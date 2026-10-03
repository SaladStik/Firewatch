/**
 * Case 1 — "Who should 311 send next?" (IEEE YP Industry Hackathon 2026).
 *
 * Score open Calgary 311 tickets, assign them to crews for one day, beat oldest-first, then apply
 * one disruption (a blizzard: ice/snow tickets jump, or a crew calls in sick), replan and report
 * how many jobs moved. Works on the live Open Calgary queue or the case's 200-ticket sample.
 * Shared by the Dispatch panel, Firefly and `npm run case:311`.
 *
 * priority = severity × impact + waiting + reports + history (+ 1000 if the dispatcher marks it urgent)
 *   severity  10 × safety (1–5 by service type)
 *   impact    × weather today and tomorrow (our Calgary forecast)
 *             × where it is. Open Calgary places 311 tickets at their community's centre (the
 *               address stays on the work order), so for those it's the community, measured inside
 *               its boundary: schools, childcare, seniors' homes and hospitals in it, crosswalks and
 *               signals per km², how hilly it is, density, industrial or not. A ticket with a real
 *               location uses the spot itself: the road it's on, a school, crosswalk or transit
 *               stop right there, a fire station close by, the slope. Capped at ×3 overall.
 *   waiting   up to 15 as the ticket approaches the city's own 90th-percentile time to close this
 *             type (Open Calgary history), then 1 a day overdue (up to 20 more): old work keeps
 *             moving, but never outranks a real hazard on age alone
 *   reports   3 per other open report of the same type within 400 m, 3 per duplicate (up to 4 each)
 *   history   + 4 / + 8 for a spot with 3+ / 10+ requests of this type in the last year,
 *             + 3 if the community reports this type at twice the city's typical rate
 * Severity first: a fresh traffic-signal outage beats a month-old parking sign. Every part is in
 * the ticket's "why", so a dispatcher can say out loud why it's where it is.
 *
 * Assignment, in two steps (see assign()): what gets done today is decided strictly by priority,
 * so the highest-priority work always gets a crew; driving only decides which crew takes it.
 * Roads crews take Roads work, Waste & Recycling crews take WRS work; anything else goes to either.
 */
import type { CityContext, RoadAt, Site } from "./cityContext";
import { haversineKm, num, parseCsv } from "./csv";

export type Unit = "Roads" | "WRS" | "Other";

export interface Ticket {
  id: string;
  date: string; // YYYY-MM-DD
  status: string;
  service: string;
  community: string;
  lat: number;
  lng: number;
  /** Duplicate reports of this ticket (merged in from "Duplicate (Open)" requests). */
  duplicates?: number;
  /**
   * Location is only the community's centre point: Open Calgary publishes 311 locations that way
   * (the address stays on the city's work order). Scored by its community, not the point.
   */
  approx?: boolean;
  /** Added by the blizzard disruption (not a real ticket). */
  simulated?: boolean;
}

/**
 * Crew work by service type: unit, safety (5 = life safety; 1 = convenience), label, and the kind
 * of hazard it is (which conditions raise it). Order matters: first match wins.
 */
type Hazard = "ice" | "signal" | "trafficSign" | "laneSign" | "pothole" | "roadway" | "debris" | "sign" | "sidewalk" | "lane" | "wall" | "light" | "minorSign" | "mobility" | "pickup" | "cart" | "other";
const TYPES: [RegExp, Unit, number, string, Hazard][] = [
  [/\b(snow|ice)\b/i, "Roads", 5, "ice / snow on the road", "ice"], // whole words: "Services" isn't ice
  [/traffic or pedestrian light repair/i, "Roads", 5, "traffic or pedestrian light out", "signal"],
  [/detour urgent/i, "Roads", 5, "unsafe detour", "trafficSign"],
  [/traffic and roadmarking/i, "Roads", 4, "traffic sign or marking down", "trafficSign"],
  [/traffic signal lane designation/i, "Roads", 3, "lane sign at a signal", "laneSign"],
  [/pothole/i, "Roads", 3, "pothole", "pothole"],
  [/roadway maintenance/i, "Roads", 3, "road surface damage", "roadway"],
  [/debris on street/i, "Roads", 3, "debris on the road", "debris"],
  [/signs - (missing|damaged)/i, "Roads", 3, "missing or damaged sign", "sign"],
  [/sidewalk - curb and gutter/i, "Roads", 2, "broken sidewalk or curb", "sidewalk"],
  [/fence - noise barrier - retaining wall/i, "Roads", 2, "damaged wall or fence", "wall"],
  [/streetlight maintenance/i, "Roads", 2, "streetlight out", "light"],
  [/debris on backlane/i, "Roads", 2, "debris in a back lane", "lane"],
  [/backlane maintenance/i, "Roads", 2, "back lane repair", "lane"],
  [/temporary sign removal/i, "Roads", 1, "temporary sign to remove", "minorSign"],
  [/signs - parking/i, "Roads", 1, "parking sign", "minorSign"],
  [/e-scooter|shared e-bike/i, "Roads", 1, "e-scooter or e-bike", "mobility"],
  [/waste - residential/i, "WRS", 2, "missed residential pickup", "pickup"],
  [/debris in backlane/i, "WRS", 2, "waste in a back lane", "lane"],
  [/blue cart|green cart|cart management|new service - carts/i, "WRS", 1, "cart repair or delivery", "cart"],
  [/commercial collection/i, "WRS", 1, "commercial collection", "pickup"],
  [/inspection/i, "Other", 2, "inspection", "other"],
  [/seniors/i, "Other", 2, "seniors' home services", "other"],
];

/** The exact Open Calgary service names that are crew field work (the live queue loads these). */
export const CREW_SERVICES = [
  "Roads - Snow and Ice Control", "Roads - Traffic or Pedestrian Light Repair", "Roads - Detour Urgent (Safety) Concerns",
  "Roads - Signs - Traffic and Roadmarking", "Roads - Traffic Signal Lane Designation Sign", "Roads - Pothole Maintenance",
  "Roads - Roadway Maintenance", "Roads - Debris on Street/Sidewalk/Boulevard", "Roads - Signs - Missing - Damaged",
  "Roads - Sidewalk - Curb and Gutter Repair", "Roads - NEW Sidewalk - Curb and Gutter Repair", "Roads - Fence - Noise Barrier - Retaining Wall Repair",
  "Roads - Streetlight Maintenance", "Roads - Debris on Backlane", "Roads - Backlane Maintenance", "Roads - Temporary Sign Removal",
  "Roads - Signs - Parking", "Roads - E-Scooter", "Roads - Shared E-Bike",
  "WRS - Waste - Residential", "WRS - Debris in Backlane", "WRS - Cart Management", "WRS - Recycling - Blue Cart",
  "WRS - Compost - Green Cart", "WRS - New Service - Carts", "WRS - Commercial Collection Services",
];

export function typeOf(service: string): { unit: Unit; safety: number; label: string; hazard: Hazard } {
  for (const [re, unit, safety, label, hazard] of TYPES) if (re.test(service)) return { unit, safety, label, hazard };
  return { unit: service.startsWith("WRS") ? "WRS" : service.startsWith("Roads") ? "Roads" : "Other", safety: 1, label: service, hazard: "other" };
}

export interface Load311 {
  open: Ticket[];
  /** Every ticket in the file (open, closed, duplicates), for the ticket list. */
  all: Ticket[];
  rows: number;
  closed: number;
  duplicates: number;
  /** Rows dropped for missing coordinates or date. */
  dropped: number;
  /** "Today" for the plan: the day after the newest ticket (sample), or today (live). */
  today: string;
  /** Where the tickets came from. */
  source: "sample" | "live";
  /** Live: when Open Calgary's data was fetched. */
  fetchedAt?: string;
}

/** A raw Open Calgary 311 row (CSV sample or the live API). */
export interface Row311 { service_request_id: string; requested_date: string; status_description: string; service_name: string; comm_name?: string; location_type?: string; latitude?: string | number; longitude?: string | number }

/** Turn rows into open tickets; duplicates become extra reports on the nearest open ticket of the same type (within 150 m). */
function fromRows(rows: Row311[], source: Load311["source"], today?: string): Load311 {
  let closed = 0, duplicates = 0, dropped = 0;
  const open: Ticket[] = [], all: Ticket[] = [], dups: Ticket[] = [];
  for (const r of rows) {
    const lat = num(String(r.latitude ?? "")), lng = num(String(r.longitude ?? "")), date = (r.requested_date || "").slice(0, 10);
    if (lat == null || lng == null || !date) { dropped++; continue; }
    // The case sample has no location_type column, but its points are community centres too.
    const approx = r.location_type ? /centrepoint/i.test(r.location_type) : source === "sample";
    const t: Ticket = { id: r.service_request_id, date, status: r.status_description, service: r.service_name, community: r.comm_name || "", lat, lng, ...(approx ? { approx } : {}) };
    all.push(t);
    if (/duplicate/i.test(r.status_description)) { duplicates++; dups.push(t); continue; }
    if (/closed/i.test(r.status_description)) { closed++; continue; }
    open.push(t);
  }
  const grid = gridOf(open);
  for (const d of dups) {
    let best: Ticket | null = null, bestKm = 0.15;
    for (const t of near(grid, d.lat, d.lng)) {
      if (t.service !== d.service) continue;
      const km = haversineKm(d.lat, d.lng, t.lat, t.lng);
      if (km < bestKm) { bestKm = km; best = t; }
    }
    if (best) best.duplicates = (best.duplicates ?? 0) + 1;
  }
  const newest = open.reduce((m, t) => (t.date > m ? t.date : m), "");
  const day = today ?? (newest ? new Date(Date.parse(`${newest}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
  return { open, all, rows: rows.length, closed, duplicates, dropped, today: day, source };
}

/** Parse the case's Open Calgary 311 CSV sample. */
export function load311(csv: string): Load311 {
  return fromRows(parseCsv(csv) as unknown as Row311[], "sample");
}

/** Today's live queue from the Open Calgary API (data/calgary311.ts), planned for today. */
export function loadLive311(rows: Row311[], fetchedAt: string): Load311 {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  return { ...fromRows(rows, "live", today), fetchedAt };
}

const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5));

export const daysWaiting = (t: Ticket, today: string) => daysBetween(t.date, today);

// ------------------------------------------------------------ a spatial grid of tickets
const G = 0.004; // degrees (~440 m × 280 m)
type Grid = Map<number, Ticket[]>;
function gridOf(ts: Ticket[]): Grid {
  const g: Grid = new Map();
  for (const t of ts) {
    const k = Math.floor(t.lat / G) * 1000003 + Math.floor(t.lng / G);
    let arr = g.get(k);
    if (!arr) g.set(k, (arr = []));
    arr.push(t);
  }
  return g;
}
function* near(g: Grid, la: number, ln: number) {
  const cy = Math.floor(la / G), cx = Math.floor(ln / G);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) yield* g.get((cy + dy) * 1000003 + cx + dx) ?? [];
}

// ------------------------------------------------------------ conditions
/** Dispatcher overrides: "urgent" jumps the queue, "hold" keeps a ticket out of today's plan. */
export type Override = "urgent" | "hold";
/** Priority boost for a ticket the dispatcher marked urgent: above anything the formula can reach. */
export const URGENT_BOOST = 1000;

/** Calgary's weather for the plan (from the map's Open-Meteo forecast), and tomorrow's. */
export interface Weather311 { tempC: number; precipMm: number; windKmh: number; tomorrow?: Weather311 | null }
/** The weather a blizzard brings (the noon disruption). */
export const BLIZZARD_WEATHER: Weather311 = { tempC: -8, precipMm: 15, windKmh: 45 };

/** How the weather scales one hazard's severity, and why. */
export function weatherFactor(label: string, w: Weather311 | null, hazard: Hazard = hazardOfLabel(label)): { k: number; why: string[] } {
  if (!w) return { k: 1, why: [] };
  const freezing = w.tempC <= 1, snow = freezing && w.precipMm >= 1, rain = !freezing && w.precipMm >= 5, wind = w.windKmh >= 50;
  let k = 1;
  const why: string[] = [];
  const bump = (m: number, reason: string) => { k *= m; why.push(reason); };
  if (hazard === "ice") { if (snow) bump(1.6, "snowing"); else if (freezing) bump(1.3, "below freezing"); }
  if ((hazard === "pothole" || hazard === "roadway") && (freezing || rain)) bump(rain ? 1.25 : 1.2, rain ? "potholes fill with rain" : "freeze-thaw");
  if ((hazard === "trafficSign" || hazard === "signal") && snow) bump(1.3, "low visibility in snow");
  if (hazard === "sidewalk" && freezing) bump(1.2, "icy broken sidewalk");
  if (hazard === "debris" && rain) bump(1.3, "heavy rain");
  if ((hazard === "sign" || hazard === "trafficSign" || hazard === "minorSign") && wind) bump(1.3, "high wind");
  if (hazard === "debris" && wind) bump(1.25, "high wind");
  if (hazard === "pickup" && wind) bump(1.15, "waste blowing around");
  // Tomorrow's forecast: get ahead of what's coming.
  const t = w.tomorrow;
  if (t) {
    const tSnow = t.tempC <= 1 && t.precipMm >= 1, tRain = t.tempC > 1 && t.precipMm >= 10;
    if (tSnow && (hazard === "ice" || hazard === "pothole" || hazard === "signal")) bump(1.15, "snow forecast tomorrow");
    if (tRain && (hazard === "pothole" || hazard === "debris" || hazard === "roadway")) bump(1.1, "heavy rain forecast tomorrow");
  }
  return { k, why };
}
const hazardOfLabel = (label: string): Hazard => TYPES.find((x) => x[3] === label)?.[4] ?? "other";

/** Similar reports nearby: same service type within this distance raise a ticket's priority. */
export const CLUSTER_KM = 0.4;
/** What a plan scores tickets with. */
export interface Ctx311 {
  weather: Weather311 | null;
  clusters: Map<string, number>;
  overrides: Record<string, Override>;
  /** Calgary context (OSM, 311 history, populations, slope); null until it loads. */
  city: CityContext | null;
  /** The road a ticket is on (route planner's street network); null until it loads. */
  roadAt: RoadAt | null;
  /** Site facts per ticket, filled lazily. */
  sites: Map<string, Site>;
}
const NO_CTX: Ctx311 = { weather: null, clusters: new Map(), overrides: {}, city: null, roadAt: null, sites: new Map() };

export function makeCtx(p: Partial<Ctx311> & { tickets?: Ticket[] } = {}): Ctx311 {
  return { weather: p.weather ?? null, clusters: p.clusters ?? (p.tickets ? similarNearby(p.tickets) : new Map()), overrides: p.overrides ?? {}, city: p.city ?? null, roadAt: p.roadAt ?? null, sites: new Map() };
}

/** Count, for every ticket, the other open tickets of the same type within CLUSTER_KM. */
export function similarNearby(tickets: Ticket[], base?: { clusters: Map<string, number>; added: Ticket[]; all: Ticket[] }): Map<string, number> {
  // Incremental: the noon replan only adds a few tickets to the morning's counts.
  if (base) {
    const out = new Map(base.clusters);
    const byType = new Map<string, Ticket[]>();
    for (const t of base.all) { let a = byType.get(t.service); if (!a) byType.set(t.service, (a = [])); a.push(t); }
    for (const t of base.added) {
      let n = 0;
      for (const o of byType.get(t.service) ?? []) {
        if (o === t || haversineKm(o.lat, o.lng, t.lat, t.lng) >= CLUSTER_KM) continue;
        n++;
        if (!base.added.includes(o)) out.set(o.id, (out.get(o.id) ?? 0) + 1);
      }
      out.set(t.id, n);
    }
    return out;
  }
  const out = new Map<string, number>();
  const byType = new Map<string, Ticket[]>();
  for (const t of tickets) { let a = byType.get(t.service); if (!a) byType.set(t.service, (a = [])); a.push(t); }
  for (const list of byType.values()) {
    const g = gridOf(list);
    for (const a of list) {
      let n = 0;
      for (const b of near(g, a.lat, a.lng)) if (b !== a && haversineKm(a.lat, a.lng, b.lat, b.lng) < CLUSTER_KM) n++;
      out.set(a.id, n);
    }
  }
  return out;
}

/** Hazards each place condition applies to. */
const ON_ROAD: Hazard[] = ["ice", "signal", "trafficSign", "laneSign", "pothole", "roadway", "debris"];
const PEDESTRIAN: Hazard[] = ["ice", "sidewalk", "debris", "signal", "trafficSign", "sign", "light"];
const VULNERABLE: Hazard[] = ["ice", "sidewalk", "trafficSign", "signal", "sign", "debris", "light", "pothole"];
const EMERGENCY: Hazard[] = ["ice", "pothole", "roadway", "debris", "signal"];
const SLOPE: Hazard[] = ["ice", "sidewalk"];
/** Any ticket open longer than this (or 3× the type's usual time to close) is "verify first". */
const STALE_DAYS = 365;
/** Ice / snow reports older than this are stale unless it's freezing now. */
const ICE_STALE_DAYS = 7;
/** Fallback "usual time to close" (days) when the history has none for a type. */
const DEFAULT_P90 = 7;

export interface PriorityParts {
  safety: number;
  /** Points from the impact multiplier (weather and place). */
  impact: number;
  weather: number;
  place: number;
  waiting: number;
  nearby: number;
  history: number;
  urgent: number;
  total: number;
  why: string[];
}

/** The priority and what it's made of (for the ticket list's and crew card's "why"). */
export function priorityParts(t: Ticket, today: string, ctx: Ctx311 = NO_CTX): PriorityParts {
  const type = typeOf(t.service), h = type.hazard;
  const why = [`${type.label} (safety ${type.safety})`];
  const safety = 10 * type.safety;
  // Impact: weather × place.
  const wf = weatherFactor(type.label, ctx.weather, h);
  why.push(...wf.why);
  let site = ctx.sites.get(t.id);
  if (!site && ctx.city) { site = ctx.city.site(t, t.approx ? null : ctx.roadAt); ctx.sites.set(t.id, site); }
  if (site && h === "ice" && daysBetween(t.date, today) > ICE_STALE_DAYS && !(ctx.weather && ctx.weather.tempC <= 1)) site = { ...site, repeats: 0 }; // a stale ice report isn't a recurring hazard today
  let pk = 1;
  const bump = (m: number, reason: string) => { pk *= m; why.push(reason); };
  const comm = t.approx && ctx.city ? ctx.city.community(t.community) : null;
  if (comm && ctx.city) {
    // The ticket's community, measured inside its boundary (the point is only its centre).
    const med = ctx.city.communityMedians, name = titleCase(t.community);
    const kids = comm.schools + comm.childcare;
    if (VULNERABLE.includes(h)) {
      if (kids >= 3) bump(1.15, `${kids} schools and childcare centres in ${name}`);
      else if (kids >= 1) bump(1.08, `${kids === 1 ? "a school" : `${kids} schools`} in ${name}`);
      if (comm.seniors) bump(1.1, `${comm.seniors === 1 ? "a seniors' home" : `${comm.seniors} seniors' homes`} in ${name}`);
      if (comm.hospitals) bump(1.08, `${comm.hospitals === 1 ? "a hospital or clinic" : `${comm.hospitals} hospitals and clinics`} in ${name}`);
    }
    if (PEDESTRIAN.includes(h) && med.crossingsPerKm2 > 0) {
      const r = comm.crossingsPerKm2 / med.crossingsPerKm2;
      if (r >= 2) bump(1.15, `busy streets on foot: ${Math.round(comm.crossingsPerKm2)} crosswalks and signals per km²`);
      else if (r >= 1.3) bump(1.07, `${Math.round(comm.crossingsPerKm2)} crosswalks and signals per km²`);
    }
    if (SLOPE.includes(h)) {
      if (comm.slopeSteepShare >= 0.15 || comm.slopeMean >= 5) bump(1.25, `hilly: ${Math.round(comm.slopeSteepShare * 100)}% of ${name} is steeper than 8%`);
      else if (comm.slopeMean >= 3) bump(1.1, `some hills (average ${comm.slopeMean}% slope)`);
    }
    if ((h === "pickup" || h === "cart") && med.density > 0 && comm.density >= 2 * med.density) bump(1.1, `dense: ${comm.density.toLocaleString("en-CA")} people per km²`);
    if ((h === "pothole" || h === "roadway") && /industrial/i.test(comm.kind)) bump(1.1, "industrial area: heavy trucks");
  } else if (site && !t.approx) {
    if (ON_ROAD.includes(h) && site.road) {
      if (site.road === "highway") bump(1.5, "on a highway");
      else if (site.road === "arterial") bump(1.35, "on a main road");
      else if (site.road === "collector") bump(1.15, "on a collector road");
      else if (site.road === "track") bump(0.85, "on a lane or track");
    }
    const kid = site.near.school ?? site.near.childcare;
    if (VULNERABLE.includes(h)) {
      if (kid !== undefined) bump(1.3, `${kid} m from a school or childcare`);
      if (site.near.seniors !== undefined) bump(1.25, `${site.near.seniors} m from a seniors' home`);
      if (site.near.hospital !== undefined) bump(1.2, `${site.near.hospital} m from a hospital or clinic`);
    }
    if (PEDESTRIAN.includes(h)) {
      const ped = [site.near.crossing !== undefined && "a crosswalk", site.near.signal !== undefined && "a traffic signal", site.near.transit !== undefined && "a transit stop"].filter(Boolean) as string[];
      if (ped.length) bump(1.2, `at ${ped.join(" and ")}`);
    }
    if (EMERGENCY.includes(h) && site.near.fire_station !== undefined) bump(1.15, `${site.near.fire_station} m from a fire station`);
    if (SLOPE.includes(h) && site.slopePct != null && site.slopePct >= 5) bump(site.slopePct >= 8 ? 1.4 : 1.2, `on a ${Math.round(site.slopePct)}% hill`);
  }
  // Weather hazards go stale: an ice report from weeks ago melted long since (the live queue holds
  // ice tickets from past winters that were never closed). Unless it's freezing now, it drops to a
  // site check.
  const age = daysBetween(t.date, today);
  const freezingNow = !!ctx.weather && ctx.weather.tempC <= 1;
  let stale = 1;
  const p90Close = Math.max(1, site?.closeP90 ?? DEFAULT_P90);
  if (h === "ice" && age > ICE_STALE_DAYS && !freezingNow) { stale = 0.15; why.splice(1, 0, `verify first: ice reported ${age} days ago and it isn't freezing now, likely melted`); }
  // The live queue has a long tail of tickets nobody closed (years old). Past a year, or three times
  // the city's usual time for the type, it's more likely done or moot than urgent: verify first.
  else if (age > Math.max(STALE_DAYS, 3 * p90Close)) { stale = 0.3; why.splice(1, 0, `verify first: open ${age} days (the city usually closes this in ${Math.round(p90Close)}), may already be fixed`); }
  const k = Math.min(3, wf.k * pk) * stale;
  const impact = Math.round(safety * (k - 1));
  const weatherPts = Math.round(safety * (Math.min(3, wf.k) * stale - 1) * (stale < 1 ? 0 : 1)), place = impact - weatherPts;
  // Waiting, against how long the city usually takes to close this type.
  const days = daysBetween(t.date, today), p90 = Math.max(1, site?.closeP90 ?? DEFAULT_P90);
  const over = Math.max(0, days - p90);
  const waiting = stale < 1 ? 0 : Math.round(15 * Math.min(1, days / p90) + Math.min(20, over));
  if (days && stale === 1) why.push(over > 0 ? `waiting ${days} days, ${Math.round(over)} past the city's usual ${Math.round(p90)}` : `waiting ${days} day${days === 1 ? "" : "s"} (city usually closes in ${Math.round(p90)})`);
  // More reports of the same thing.
  const nearN = Math.min(4, ctx.clusters.get(t.id) ?? 0), dup = Math.min(4, t.duplicates ?? 0);
  const nearby = 3 * nearN + 3 * dup;
  if (nearN) why.push(t.approx ? `${nearN} more open report${nearN === 1 ? "" : "s"} of this in ${titleCase(t.community)}` : `${nearN} similar report${nearN === 1 ? "" : "s"} within ${CLUSTER_KM * 1000} m`);
  if (dup) why.push(`reported ${dup + 1} times`);
  // History: a recurring spot, or a community that reports this a lot.
  let history = 0;
  if (!t.approx && site?.repeats && site.repeats >= 3) { history += site.repeats >= 10 ? 8 : 4; why.push(`recurring spot: ${site.repeats} requests here last year`); }
  if (site?.areaRate != null && site.areaRateMedian && site.areaRate >= 2 * site.areaRateMedian) { history += 3; why.push(`${titleCase(t.community)} reports this ${(site.areaRate / site.areaRateMedian).toFixed(1)}× the city's typical rate`); }
  const urgent = ctx.overrides[t.id] === "urgent" ? URGENT_BOOST : 0;
  if (urgent) why.push("marked urgent");
  return { safety, impact, weather: weatherPts, place, waiting, nearby, history, urgent, total: safety + impact + waiting + nearby + history + urgent, why };
}

export function priority(t: Ticket, today: string, ctx: Ctx311 = NO_CTX): number {
  if (ctx === NO_CTX) return priorityParts(t, today, ctx).total;
  let memo = PMEMO.get(ctx);
  if (!memo) PMEMO.set(ctx, (memo = new Map()));
  let v = memo.get(t.id);
  if (v === undefined) { v = priorityParts(t, today, ctx).total; memo.set(t.id, v); }
  return v;
}
const PMEMO = new WeakMap<Ctx311, Map<string, number>>();

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------ crews and assignment
export interface Crew { id: string; unit: Exclude<Unit, "Other"> }

export function makeCrews(roads: number, waste: number): Crew[] {
  return [
    ...Array.from({ length: roads }, (_, i) => ({ id: `R${i + 1}`, unit: "Roads" as const })),
    ...Array.from({ length: waste }, (_, i) => ({ id: `W${i + 1}`, unit: "WRS" as const })),
  ];
}

export interface Assignment {
  /** Crew id → its jobs in visiting order. */
  routes: Map<string, Ticket[]>;
  /** Open tickets left for tomorrow. */
  waiting: Ticket[];
}

/** Depot the day starts from (Calgary Roads / WRS operations, approximate). */
export const DEPOT = { lat: 51.0447, lng: -114.0719 };
/** Assignment bonuses, in km of driving they're worth: same community, same kind of job close by, morning crew. */
const SAME_COMMUNITY_KM = 2, SAME_TYPE_NEAR_KM = 1.5, KEEP_CREW_KM = 4;

export type Strategy = "fifo" | "priority";

/**
 * Fill the crews' day (up to `perCrew` jobs each).
 *
 * FIFO (the baseline): crews take the oldest ticket they can do, ignoring type.
 *
 * Priority, in two steps, so importance and driving never trade off against each other:
 *  1. What gets done today: the day's slots are filled strictly in priority order (per unit: Roads
 *     slots with Roads work, Waste slots with WRS work, either with the rest). A waiting ticket
 *     never outranks a planned one its unit could have done, and an urgent ticket always gets a crew.
 *  2. Who does it: the chosen tickets go, highest priority first, to the crew that adds the least
 *     driving (nearest to that crew's jobs so far), with bonuses for the same community, the same
 *     kind of job close by, and (`previous`, on a replan) the job's morning crew.
 * Each crew's list stays in priority order; the route planner can re-order it for driving.
 */
export function assign(tickets: Ticket[], crews: Crew[], perCrew: number, today: string, strategy: Strategy, ctx: Ctx311 = NO_CTX, previous?: Assignment): Assignment {
  const prevCrew = new Map<string, string>();
  previous?.routes.forEach((list, crew) => list.forEach((t) => prevCrew.set(t.id, crew)));
  const left = new Map(tickets.map((t) => [t.id, t]));
  const routes = new Map(crews.map((c) => [c.id, [] as Ticket[]]));
  const pr = new Map(tickets.map((t) => [t.id, priority(t, today, ctx)]));
  if (strategy === "fifo") {
    // Oldest first (ties by ticket number), handed round-robin to the crews that can do them.
    const oldest = [...tickets].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const turn = new Map<Unit, number>([["Roads", 0], ["WRS", 0]]);
    for (const t of oldest) {
      const u = typeOf(t.service).unit;
      const able = crews.filter((c) => (u === "Other" || c.unit === u) && routes.get(c.id)!.length < perCrew);
      if (!able.length) continue;
      const k = turn.get(u === "Other" ? able[0].unit : u) ?? 0;
      const c = able[k % able.length];
      turn.set(c.unit, k + 1);
      routes.get(c.id)!.push(t);
      left.delete(t.id);
      if (crews.every((x) => routes.get(x.id)!.length >= perCrew)) break;
    }
  } else {
    // 1. What gets done: strictly by priority, within each unit's slots. Among tickets of EQUAL
    // priority (a band that doesn't all fit), the ones nearest work already chosen go first, so a
    // tie never costs a crew a trip across the city.
    const ranked = [...tickets].sort((a, b) => pr.get(b.id)! - pr.get(a.id)! || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const free = new Map<Unit, number>([["Roads", 0], ["WRS", 0]]);
    for (const c of crews) free.set(c.unit, free.get(c.unit)! + perCrew);
    const chosen: Ticket[] = [];
    const slotFor = (t: Ticket): Unit | null => {
      const u = typeOf(t.service).unit;
      if (u !== "Other") return free.get(u)! > 0 ? u : null;
      const r = free.get("Roads")!, w = free.get("WRS")!;
      return r >= w ? (r > 0 ? "Roads" : null) : w > 0 ? "WRS" : null;
    };
    const nearChosen = (t: Ticket) => chosen.reduce((m, c) => Math.min(m, haversineKm(c.lat, c.lng, t.lat, t.lng)), haversineKm(DEPOT.lat, DEPOT.lng, t.lat, t.lng));
    for (let i = 0; i < ranked.length;) {
      let j = i;
      while (j < ranked.length && pr.get(ranked[j].id) === pr.get(ranked[i].id)) j++;
      const band = ranked.slice(i, j);
      i = j;
      while (band.length) {
        const fits = band.filter((t) => slotFor(t));
        if (!fits.length) break;
        // Everything left in the band fits: order doesn't matter. Otherwise take the nearest first.
        const t = fits.reduce((best, x) => (nearChosen(x) < nearChosen(best) ? x : best));
        const unit = slotFor(t)!;
        free.set(unit, free.get(unit)! - 1);
        chosen.push(t);
        band.splice(band.indexOf(t), 1);
      }
    }
    // 2. Who does it: the crew that adds the least driving, highest priority placed first.
    const unitOf = new Map<string, Unit>();
    { // Remember which unit's slot each "Other" ticket took, so step 2 respects the same split.
      const f = new Map<Unit, number>([["Roads", 0], ["WRS", 0]]);
      for (const c of crews) f.set(c.unit, f.get(c.unit)! + perCrew);
      for (const t of chosen) {
        const u = typeOf(t.service).unit;
        const unit: Unit = u !== "Other" ? u : f.get("Roads")! >= f.get("WRS")! ? "Roads" : "WRS";
        f.set(unit, f.get(unit)! - 1);
        unitOf.set(t.id, unit);
      }
    }
    for (const t of chosen) {
      let best: Crew | null = null, bestCost = Infinity;
      for (const c of crews) {
        const list = routes.get(c.id)!;
        if (c.unit !== unitOf.get(t.id) || list.length >= perCrew) continue;
        // Driving this job adds: distance to the nearest of the crew's jobs (or from the depot).
        let km = list.length ? Infinity : haversineKm(DEPOT.lat, DEPOT.lng, t.lat, t.lng);
        for (const j of list) km = Math.min(km, haversineKm(j.lat, j.lng, t.lat, t.lng));
        let cost = km;
        if (list.some((j) => j.community && j.community === t.community)) cost -= SAME_COMMUNITY_KM;
        if (list.some((j) => j.service === t.service && haversineKm(j.lat, j.lng, t.lat, t.lng) < 1)) cost -= SAME_TYPE_NEAR_KM;
        if (prevCrew.get(t.id) === c.id) cost -= KEEP_CREW_KM;
        // An empty crew is a fresh truck: don't pile everything on the first crew's cluster.
        if (!list.length) cost -= 0.5;
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      if (!best) continue;
      routes.get(best.id)!.push(t);
      left.delete(t.id);
    }
  }
  const waiting = [...left.values()].sort((a, b) => pr.get(b.id)! - pr.get(a.id)!);
  return { routes, waiting };
}

export interface Score311 {
  jobs: number;
  /** Sum of safety levels of the jobs done (higher = more safety work done). */
  safety: number;
  /** Jobs at safety ≥ 3 (ice/snow, traffic control, potholes, debris, damaged signs). */
  safetyJobs: number;
  /** Safety-critical tickets left waiting. */
  safetyLeft: number;
  /** Total driving (km, straight line between stops, from the depot). */
  km: number;
}

export function score311(a: Assignment): Score311 {
  let jobs = 0, safety = 0, safetyJobs = 0, km = 0;
  a.routes.forEach((list) => {
    let at = DEPOT;
    for (const t of list) {
      const s = typeOf(t.service).safety;
      jobs++; safety += s; if (s >= 3) safetyJobs++;
      km += haversineKm(at.lat, at.lng, t.lat, t.lng);
      at = t;
    }
  });
  return { jobs, safety, safetyJobs, safetyLeft: a.waiting.filter((t) => typeOf(t.service).safety >= 3).length, km };
}

// ------------------------------------------------------------ disruptions
export type Disruption = "none" | "blizzard" | "sick";

/**
 * Blizzard: ice and snow tickets jump. Calgary 311 gets a wave of "Roads - Snow and Ice Control"
 * calls; we add `count` of them (seeded, so the demo repeats) at existing ticket locations, dated
 * today. Marked simulated.
 */
export function blizzardTickets(tickets: Ticket[], today: string, count = 18, seed = 7): Ticket[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Ticket[] = [];
  for (let i = 0; i < count && tickets.length; i++) {
    const base = tickets[Math.floor(rnd() * tickets.length)];
    out.push({
      id: `SIM-ICE-${String(i + 1).padStart(2, "0")}`, date: today, status: "Open", service: "Roads - Snow and Ice Control",
      community: base.community, lat: base.lat + (rnd() - 0.5) * 0.01, lng: base.lng + (rnd() - 0.5) * 0.015, simulated: true, approx: base.approx,
    });
  }
  return out;
}

export interface Plan311 {
  today: string;
  crews: Crew[];
  perCrew: number;
  fifo: Assignment;
  morning: Assignment;
  disruption: Disruption;
  /** After the disruption: the tickets and crews the noon replan worked with. */
  noonCrews: Crew[];
  noon: Assignment | null;
  added: Ticket[];
  /** Jobs that changed crew, were dropped to tomorrow, or are new at noon. */
  moved: { ticket: Ticket; from: string; to: string }[];
  dropped: { ticket: Ticket; from: string }[];
  newJobs: { ticket: Ticket; to: string }[];
  scores: { fifo: Score311; morning: Score311; noon: Score311 | null };
  /** What the 8 a.m. plan and the noon replan scored tickets with (weather, clusters, overrides). */
  ctx: Ctx311;
  noonCtx: Ctx311;
}

// ------------------------------------------------------------ the week's schedule
/** One day of the schedule, for the panel's week strip. */
export interface DaySummary { day: number; date: string; jobs: number; safetyJobs: number; open: number; weather: Weather311 | null }

/** Days in the schedule (today + the 7-day forecast, like the map). */
export const SCHEDULE_DAYS = 8;

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * The ticket set for the next day of a schedule: what's still open after the day's plan was worked
 * (blizzard calls carry over if they weren't reached), a day later.
 */
export function nextDay(load: Load311, plan: Plan311): Load311 {
  const final = plan.noon ?? plan.morning;
  const done = new Set<string>();
  final.routes.forEach((list) => list.forEach((t) => done.add(t.id)));
  return { ...load, open: [...load.open, ...plan.added].filter((t) => !done.has(t.id)), today: addDays(plan.today, 1) };
}

export function summarize(plan: Plan311, day: number, weather: Weather311 | null): DaySummary {
  const final = plan.noon ?? plan.morning, s = plan.noon ? plan.scores.noon! : plan.scores.morning;
  return { day, date: plan.today, jobs: s.jobs, safetyJobs: s.safetyJobs, open: final.waiting.length + s.jobs, weather };
}

/** Scoring contexts per ticket set (see plan311). */
const CTX_CACHE = new WeakMap<Load311, { key: string; ctx: Ctx311; noon: Map<Disruption, Ctx311> }>();

export function plan311(load: Load311, opts: { roads?: number; waste?: number; perCrew?: number; disruption?: Disruption; overrides?: Record<string, Override>; weather?: Weather311 | null; city?: CityContext | null; roadAt?: RoadAt | null } = {}): Plan311 {
  const overrides = opts.overrides ?? {};
  // Scores only depend on the tickets, weather, overrides and context: reuse them across replans
  // that only change crews (priorities are memoised per ctx).
  const key = JSON.stringify([opts.weather ?? null, overrides, !!opts.city, !!opts.roadAt]);
  let cached = CTX_CACHE.get(load);
  if (!cached || cached.key !== key) CTX_CACHE.set(load, (cached = { key, ctx: makeCtx({ weather: opts.weather, tickets: load.open, overrides, city: opts.city, roadAt: opts.roadAt }), noon: new Map() }));
  const ctx = cached.ctx;
  const crews = makeCrews(opts.roads ?? 5, opts.waste ?? 3), perCrew = opts.perCrew ?? 5, today = load.today;
  // Held tickets stay out of today's plans (both ours and the baseline's).
  const open = load.open.filter((t) => overrides[t.id] !== "hold");
  const fifo = assign(open, crews, perCrew, today, "fifo", ctx);
  const morning = assign(open, crews, perCrew, today, "priority", ctx);
  const disruption = opts.disruption ?? "none";
  let noonCrews = crews, tickets = open, added: Ticket[] = [];
  if (disruption === "blizzard") { added = blizzardTickets(load.open, today); tickets = [...open, ...added.filter((t) => overrides[t.id] !== "hold")]; }
  if (disruption === "sick") {
    // The busiest Roads crew calls in sick.
    const busiest = crews.filter((c) => c.unit === "Roads").sort((a, b) => morning.routes.get(b.id)!.length - morning.routes.get(a.id)!.length)[0];
    noonCrews = crews.filter((c) => c !== busiest);
  }
  // A blizzard brings its weather with it; the noon replan scores with that.
  let noonCtx: Ctx311 = ctx;
  if (disruption !== "none") {
    const hit = cached.noon.get(disruption);
    if (hit) noonCtx = hit;
    else {
      const noonClusters = disruption === "blizzard" ? similarNearby(tickets, { clusters: ctx.clusters, added, all: tickets }) : ctx.clusters;
      noonCtx = { ...makeCtx({ weather: disruption === "blizzard" ? BLIZZARD_WEATHER : ctx.weather, clusters: noonClusters, overrides, city: ctx.city, roadAt: ctx.roadAt }), sites: ctx.sites };
      cached.noon.set(disruption, noonCtx);
    }
  }
  const noon = disruption === "none" ? null : assign(tickets, noonCrews, perCrew, today, "priority", noonCtx, morning);
  const crewOf = (a: Assignment) => { const m = new Map<string, string>(); a.routes.forEach((l, c) => l.forEach((t) => m.set(t.id, c))); return m; };
  const before = crewOf(morning), after = noon ? crewOf(noon) : before;
  const moved: Plan311["moved"] = [], dropped: Plan311["dropped"] = [], newJobs: Plan311["newJobs"] = [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  if (noon) {
    before.forEach((from, id) => {
      const to = after.get(id);
      if (!to) dropped.push({ ticket: byId.get(id)!, from });
      else if (to !== from) moved.push({ ticket: byId.get(id)!, from, to });
    });
    after.forEach((to, id) => { if (!before.has(id)) newJobs.push({ ticket: byId.get(id)!, to }); });
  }
  return {
    today, crews, perCrew, fifo, morning, disruption, noonCrews, noon, added, moved, dropped, newJobs,
    scores: { fifo: score311(fifo), morning: score311(morning), noon: noon ? score311(noon) : null },
    ctx, noonCtx,
  };
}

// ------------------------------------------------------------ the supervisor
const kmTxt = (km: number) => `${Math.round(km)} km`;

/** What to tell the supervisor at 8 a.m. (the morning plan). */
export function supervisor8am(p: Plan311): string {
  const f = p.scores.fifo, m = p.scores.morning;
  const top = [...p.morning.routes.entries()].map(([crew, list]) => list[0] ? `${crew} → ${typeOf(list[0].service).label} in ${title(list[0].community)}` : "").filter(Boolean).slice(0, 4);
  return `8 a.m.: ${p.crews.length} crews, ${p.perCrew} jobs each, ${m.jobs} of ${p.morning.waiting.length + m.jobs} open tickets today. ` +
    `Safety work first: ${m.safetyJobs} safety jobs (ice, traffic control, potholes, debris, damaged signs) instead of ${f.safetyJobs} under oldest-first, ` +
    `and crews stay in their neighbourhoods: ${kmTxt(m.km)} of driving instead of ${kmTxt(f.km)}. First stops: ${top.join("; ")}.`;
}

/** What to tell the supervisor at noon (after the disruption and replan). */
export function supervisorNoon(p: Plan311): string {
  if (!p.noon || !p.scores.noon) return "Noon: no disruption, the morning plan stands.";
  const n = p.scores.noon;
  const what = p.disruption === "blizzard"
    ? `the blizzard added ${p.added.length} ice and snow calls`
    : `crew ${p.crews.find((c) => !p.noonCrews.includes(c))?.id} called in sick`;
  return `Noon: ${what}. Replanned: ${p.moved.length} job${p.moved.length === 1 ? "" : "s"} changed crew, ${p.dropped.length} moved to tomorrow, ${p.newJobs.length} new. ` +
    `${n.safetyJobs} safety jobs still get done today${p.dropped.length ? `; what slips is the lowest priority: ${[...new Set(p.dropped.map((d) => typeOf(d.ticket.service).label))].slice(0, 3).join(", ")}` : ""}. ` +
    `Jobs keep their morning crew where possible, so most crews' afternoons don't change.`;
}

const title = titleCase;
