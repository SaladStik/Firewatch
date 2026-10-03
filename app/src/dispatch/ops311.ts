/**
 * Case 1 — "Who should 311 send next?" (IEEE YP Industry Hackathon 2026).
 *
 * Score open Calgary 311 tickets, assign them to a few crews for one day, beat oldest-first, then
 * apply one disruption (a blizzard: ice/snow tickets jump, or a crew calls in sick), replan and
 * report how many jobs moved. Shared by the Dispatch panel, Firefly and `npm run case:311`.
 *
 * One-line priority:   priority = 10 × safety × weather + 2 × days waiting + 3 × similar reports nearby
 *   - severity first: a new traffic-sign ticket (40) goes before a week-old parking sign (24);
 *     waiting adds 2 a day so nothing waits forever;
 *   - weather (our Calgary forecast): freezing and snow raise ice and potholes, heavy rain raises
 *     debris and potholes, high wind raises signs and debris;
 *   - similar open tickets within 400 m (up to 4) mean a bigger problem, so the cluster rises.
 * Assignment, in two steps (see assign()): what gets done today is decided strictly by priority,
 * so the highest-priority work always gets a crew; driving only decides which crew takes it
 * (nearest to that crew's other jobs, same community, same kind of job close by).
 * Roads crews take Roads work, Waste & Recycling crews take WRS work; anything else goes to either.
 */
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
  /** Added by the blizzard disruption (not a real ticket). */
  simulated?: boolean;
}

/** Service type → unit and safety (5 = life safety: ice, traffic control; 1 = convenience). */
const TYPES: [RegExp, Unit, number, string][] = [
  [/\b(snow|ice)\b/i, "Roads", 5, "ice / snow on the road"], // whole words: "Services" isn't ice
  [/traffic and roadmarking/i, "Roads", 4, "traffic sign or marking down"],
  [/pothole/i, "Roads", 3, "pothole"],
  [/debris/i, "Roads", 3, "debris on the road"],
  [/signs - (missing|damaged)/i, "Roads", 3, "missing or damaged sign"],
  [/streetlight/i, "Roads", 2, "streetlight out"],
  [/signs - parking/i, "Roads", 1, "parking sign"],
  [/waste - residential/i, "WRS", 2, "missed residential pickup"],
  [/commercial collection/i, "WRS", 1, "commercial collection"],
  [/new service - carts/i, "WRS", 1, "new cart"],
  [/inspection/i, "Other", 2, "inspection"],
  [/seniors/i, "Other", 2, "seniors' home services"],
];

export function typeOf(service: string): { unit: Unit; safety: number; label: string } {
  for (const [re, unit, safety, label] of TYPES) if (re.test(service)) return { unit, safety, label };
  return { unit: service.startsWith("WRS") ? "WRS" : service.startsWith("Roads") ? "Roads" : "Other", safety: 1, label: service };
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
  /** "Today" for the plan: the day after the newest ticket. */
  today: string;
}

/** Parse Open Calgary 311 rows (service_request_id, requested_date, status_description, service_name, comm_name, longitude, latitude). */
export function load311(csv: string): Load311 {
  const rows = parseCsv(csv);
  let closed = 0, duplicates = 0, dropped = 0;
  const open: Ticket[] = [], all: Ticket[] = [];
  for (const r of rows) {
    const lat = num(r.latitude), lng = num(r.longitude), date = (r.requested_date || "").slice(0, 10);
    if (lat == null || lng == null || !date) { dropped++; continue; }
    const t: Ticket = { id: r.service_request_id, date, status: r.status_description, service: r.service_name, community: r.comm_name || "", lat, lng };
    all.push(t);
    if (/duplicate/i.test(r.status_description)) { duplicates++; continue; }
    if (/closed/i.test(r.status_description)) { closed++; continue; }
    open.push(t);
  }
  const newest = open.reduce((m, t) => (t.date > m ? t.date : m), "");
  const today = newest ? new Date(Date.parse(`${newest}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return { open, all, rows: rows.length, closed, duplicates, dropped, today };
}

const daysBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5));

export const daysWaiting = (t: Ticket, today: string) => daysBetween(t.date, today);

/** Dispatcher overrides: "urgent" jumps the queue, "hold" keeps a ticket out of today's plan. */
export type Override = "urgent" | "hold";
/** Priority boost for a ticket the dispatcher marked urgent (above any safety level). */
export const URGENT_BOOST = 100;

/** Calgary's weather for the plan (from the map's Open-Meteo forecast). */
export interface Weather311 { tempC: number; precipMm: number; windKmh: number }
/** The weather a blizzard brings (the noon disruption). */
export const BLIZZARD_WEATHER: Weather311 = { tempC: -8, precipMm: 15, windKmh: 45 };

/** How the weather scales one service type's severity, and why. */
export function weatherFactor(label: string, w: Weather311 | null): { k: number; why: string[] } {
  if (!w) return { k: 1, why: [] };
  const freezing = w.tempC <= 1, snow = freezing && w.precipMm >= 1, rain = !freezing && w.precipMm >= 5, wind = w.windKmh >= 50;
  let k = 1;
  const why: string[] = [];
  const bump = (m: number, reason: string) => { k *= m; why.push(reason); };
  if (/ice/.test(label)) { if (snow) bump(1.6, "snowing"); else if (freezing) bump(1.3, "below freezing"); }
  if (/pothole/.test(label) && (freezing || rain)) bump(rain ? 1.25 : 1.2, rain ? "potholes fill with rain" : "freeze-thaw");
  if (/traffic sign/.test(label) && snow) bump(1.3, "low visibility in snow");
  if (/debris/.test(label) && rain) bump(1.3, "heavy rain");
  if (/sign/.test(label) && wind) bump(1.3, "high wind");
  if (/debris/.test(label) && wind) bump(1.25, "high wind");
  if (/pickup/.test(label) && wind) bump(1.15, "waste blowing around");
  return { k, why };
}

/** Similar reports nearby: same service type within this distance raise a ticket's priority. */
export const CLUSTER_KM = 0.4;
/** What a plan scores tickets with: the weather, similar reports nearby, the dispatcher's overrides. */
export interface Ctx311 {
  weather: Weather311 | null;
  clusters: Map<string, number>;
  overrides: Record<string, Override>;
}
const NO_CTX: Ctx311 = { weather: null, clusters: new Map(), overrides: {} };

/** Count, for every ticket, the other open tickets of the same type within CLUSTER_KM. */
export function similarNearby(tickets: Ticket[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of tickets) {
    let n = 0;
    for (const b of tickets) if (b !== a && b.service === a.service && haversineKm(a.lat, a.lng, b.lat, b.lng) < CLUSTER_KM) n++;
    out.set(a.id, n);
  }
  return out;
}

export interface PriorityParts { safety: number; weather: number; waiting: number; nearby: number; urgent: number; total: number; why: string[] }

/** The priority and what it's made of (for the ticket list's "why"). */
export function priorityParts(t: Ticket, today: string, ctx: Ctx311 = NO_CTX): PriorityParts {
  const type = typeOf(t.service), wf = weatherFactor(type.label, ctx.weather);
  const near = Math.min(4, ctx.clusters.get(t.id) ?? 0), days = daysBetween(t.date, today);
  const safety = 10 * type.safety, weatherPts = Math.round(safety * (wf.k - 1)), waiting = 2 * days, nearby = 3 * near;
  const urgent = ctx.overrides[t.id] === "urgent" ? URGENT_BOOST : 0;
  const why = [`${type.label} (safety ${type.safety})`];
  if (wf.why.length) why.push(...wf.why);
  if (days) why.push(`waiting ${days} day${days === 1 ? "" : "s"}`);
  if (near) why.push(`${near} similar report${near === 1 ? "" : "s"} within ${CLUSTER_KM * 1000} m`);
  if (urgent) why.push("marked urgent");
  return { safety, weather: weatherPts, waiting, nearby, urgent, total: safety + weatherPts + waiting + nearby + urgent, why };
}

export function priority(t: Ticket, today: string, ctx: Ctx311 = NO_CTX): number {
  return priorityParts(t, today, ctx).total;
}

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

const canDo = (c: Crew, t: Ticket) => { const u = typeOf(t.service).unit; return u === "Other" || u === c.unit; };
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
    const pos = new Map(crews.map((c) => [c.id, DEPOT]));
    for (let round = 0; round < perCrew; round++) {
      for (const c of crews) {
        let best: Ticket | null = null, bestV = -Infinity;
        for (const t of left.values()) {
          if (!canDo(c, t)) continue;
          const v = -Date.parse(t.date) / 864e5 - (Number(t.id.replace(/\D/g, "")) || 0) * 1e-9;
          if (v > bestV) { bestV = v; best = t; }
        }
        if (!best) continue;
        routes.get(c.id)!.push(best);
        pos.set(c.id, best);
        left.delete(best.id);
      }
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
      community: base.community, lat: base.lat + (rnd() - 0.5) * 0.01, lng: base.lng + (rnd() - 0.5) * 0.015, simulated: true,
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

export function plan311(load: Load311, opts: { roads?: number; waste?: number; perCrew?: number; disruption?: Disruption; overrides?: Record<string, Override>; weather?: Weather311 | null } = {}): Plan311 {
  const overrides = opts.overrides ?? {};
  const ctx: Ctx311 = { weather: opts.weather ?? null, clusters: similarNearby(load.open), overrides };
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
  const noonCtx: Ctx311 = disruption === "none" ? ctx : { weather: disruption === "blizzard" ? BLIZZARD_WEATHER : ctx.weather, clusters: similarNearby(tickets), overrides };
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

const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
