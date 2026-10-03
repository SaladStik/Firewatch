/**
 * Case 1 — "Who should 311 send next?" (IEEE YP Industry Hackathon 2026).
 *
 * Score open Calgary 311 tickets, assign them to a few crews for one day, beat oldest-first, then
 * apply one disruption (a blizzard: ice/snow tickets jump, or a crew calls in sick), replan and
 * report how many jobs moved. Shared by the Dispatch panel, Firefly and `npm run case:311`.
 *
 * One-line priority:   priority = 10 × safety + 2 × days waiting
 * Assignment: each crew picks its next job by priority − 1.5 × km from its last job (+ 6 for the
 * same community), so a crew works a neighbourhood instead of crossing the city for every ticket.
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
let overrides: Record<string, Override> = {};

export function priority(t: Ticket, today: string): number {
  return 10 * typeOf(t.service).safety + 2 * daysBetween(t.date, today) + (overrides[t.id] === "urgent" ? URGENT_BOOST : 0);
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
const DEPOT = { lat: 51.0447, lng: -114.0719 };
const KM_COST = 1.5, SAME_COMMUNITY = 6, KEEP_CREW = 8;

export type Strategy = "fifo" | "priority";

/**
 * Fill each crew up to `perCrew` jobs. FIFO: oldest ticket first, ignore type (the baseline).
 * Priority: highest priority first, then the next job by priority − travel (+ same community).
 * `previous`: on a replan, a job keeps its morning crew when it can (fewer phone calls).
 */
export function assign(tickets: Ticket[], crews: Crew[], perCrew: number, today: string, strategy: Strategy, previous?: Assignment): Assignment {
  const prevCrew = new Map<string, string>();
  previous?.routes.forEach((list, crew) => list.forEach((t) => prevCrew.set(t.id, crew)));
  const left = new Map(tickets.map((t) => [t.id, t]));
  const routes = new Map(crews.map((c) => [c.id, [] as Ticket[]]));
  const pos = new Map(crews.map((c) => [c.id, DEPOT]));
  const pr = new Map(tickets.map((t) => [t.id, priority(t, today)]));
  // Round-robin so every crew gets its best next job in turn.
  for (let round = 0; round < perCrew; round++) {
    for (const c of crews) {
      let best: Ticket | null = null, bestV = -Infinity;
      const here = pos.get(c.id)!, last = routes.get(c.id)!.at(-1);
      for (const t of left.values()) {
        if (!canDo(c, t)) continue;
        let v: number;
        if (strategy === "fifo") v = -Date.parse(t.date) / 864e5 - (Number(t.id.replace(/\D/g, "")) || 0) * 1e-9;
        else {
          v = pr.get(t.id)! - KM_COST * haversineKm(here.lat, here.lng, t.lat, t.lng);
          if (last && last.community && last.community === t.community) v += SAME_COMMUNITY;
          if (prevCrew.get(t.id) === c.id) v += KEEP_CREW;
        }
        if (v > bestV) { bestV = v; best = t; }
      }
      if (!best) continue;
      routes.get(c.id)!.push(best);
      pos.set(c.id, best);
      left.delete(best.id);
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
}

export function plan311(load: Load311, opts: { roads?: number; waste?: number; perCrew?: number; disruption?: Disruption; overrides?: Record<string, Override> } = {}): Plan311 {
  overrides = opts.overrides ?? {};
  const crews = makeCrews(opts.roads ?? 5, opts.waste ?? 3), perCrew = opts.perCrew ?? 5, today = load.today;
  // Held tickets stay out of today's plans (both ours and the baseline's).
  const open = load.open.filter((t) => overrides[t.id] !== "hold");
  const fifo = assign(open, crews, perCrew, today, "fifo");
  const morning = assign(open, crews, perCrew, today, "priority");
  const disruption = opts.disruption ?? "none";
  let noonCrews = crews, tickets = open, added: Ticket[] = [];
  if (disruption === "blizzard") { added = blizzardTickets(load.open, today); tickets = [...open, ...added.filter((t) => overrides[t.id] !== "hold")]; }
  if (disruption === "sick") {
    // The busiest Roads crew calls in sick.
    const busiest = crews.filter((c) => c.unit === "Roads").sort((a, b) => morning.routes.get(b.id)!.length - morning.routes.get(a.id)!.length)[0];
    noonCrews = crews.filter((c) => c !== busiest);
  }
  const noon = disruption === "none" ? null : assign(tickets, noonCrews, perCrew, today, "priority", morning);
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
