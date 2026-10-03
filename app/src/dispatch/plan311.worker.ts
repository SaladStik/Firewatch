/**
 * Calgary 311 planning, off the main thread: holds the ticket sets (live queue and case sample),
 * the Calgary context and the street network; scores, assigns and routes on request. The map and
 * the panel stay smooth however big the live queue is (~25,000 open tickets).
 *
 * Website only: this worker fetches Open Calgary itself and works out each ticket's site.
 * Website + data server: the queue comes from the server's cache with every ticket's site
 * already worked out (server/index.ts), so plans are ready in well under a second.
 */
import { PROJECTION } from "../config/regions";
import { loadCalgary311 } from "../data/liveData";
import { setProjection } from "../geo/projection";
import { CityContext, type CityContextFile, type Site } from "./cityContext";
import { DEPOT, load311, loadLive311, nextDay, plan311, SCHEDULE_DAYS, summarize, type DaySummary, type Disruption, type Load311, type Override, type Plan311, type Row311, type Weather311 } from "./ops311";
import { RoadGraph, routeStops, shortestOrder, type CrewRoute } from "./router";

setProjection(PROJECTION);

export type Source311 = "live" | "sample";
/** `weatherDays[d]`: Calgary's forecast for day d of the week (today = 0), each with its next day attached. */
export interface PlanOpts { roads: number; waste: number; perCrew: number; disruption: Disruption; overrides: Record<string, Override>; weatherDays: (Weather311 | null)[] }

export type ToWorker =
  | { type: "init"; base: string }
  | { type: "plan"; id: number; source: Source311; opts: PlanOpts; day: number; at: "morning" | "noon"; routeOrder: Record<string, number[]>; needLoad: boolean }
  | { type: "shortest"; id: number; crew: string }
  | { type: "refresh" };
export interface LoadInfo { source: Source311; version: number; load: Load311 }
export type FromWorker =
  | { type: "status"; live: "idle" | "loading" | "ready" | "error"; liveError: string; city: boolean; roads: "idle" | "loading" | "ready" | "error"; scoring: boolean }
  | { type: "plan"; id: number; day: number; plan: Plan311; routes: Record<string, CrewRoute>; load: LoadInfo | null; schedule: DaySummary[]; ms: number }
  | { type: "schedule"; schedule: DaySummary[] }
  | { type: "shortest"; id: number; order: number[] };

let base = "/";
let sample: Load311 | null = null;
let live: Load311 | null = null;
let liveVersion = 0, sampleVersion = 0;
const sent = new Map<Source311, number>();
let city: CityContext | null = null;
let roads: RoadGraph | null = null;
const status: Extract<FromWorker, { type: "status" }> = { type: "status", live: "idle", liveError: "", city: false, roads: "idle", scoring: false };
let lastPlan: { plan: Plan311; at: "morning" | "noon" } | null = null;
let liveFetched = 0;
const LIVE_TTL_MS = 10 * 60_000;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const say = (patch: Partial<typeof status>) => { Object.assign(status, patch); post({ ...status }); };

// ------------------------------------------------------------ data (each loads once)
let cityP: Promise<void> | null = null, roadsP: Promise<void> | null = null, sampleP: Promise<void> | null = null, liveP: Promise<void> | null = null;

function loadCity() {
  return (cityP ??= (async () => {
    try {
      city = new CityContext((await (await fetch(`${base}data/cases/calgary_context.json`)).json()) as CityContextFile);
      say({ city: true });
    } catch { cityP = null; }
  })());
}

function loadRoads() {
  return (roadsP ??= (async () => {
    say({ roads: "loading" });
    try {
      const idx = (await (await fetch(`${base}data/alberta/lines/index.json`)).json()) as { q: number; tiles: string[] };
      const want = ["50_-115", "50_-114", "51_-115", "51_-114"].filter((n) => idx.tiles.includes(n));
      const tiles = await Promise.all(want.map((n) => fetch(`${base}data/alberta/lines/${n}.json`).then((r) => r.json())));
      roads = new RoadGraph(tiles, idx.q, [-114.40, 50.80, -113.80, 51.26]);
      say({ roads: "ready" });
    } catch { roadsP = null; say({ roads: "error" }); }
  })());
}

function loadSample() {
  return (sampleP ??= (async () => {
    sample = load311(await (await fetch(`${base}data/cases/calgary_311_sample.csv`)).text());
    sampleVersion++;
  })());
}

function loadLive(force = false) {
  if (force || (live && Date.now() - liveFetched > LIVE_TTL_MS)) liveP = null;
  return (liveP ??= (async () => {
    say({ live: "loading", liveError: "" });
    try {
      const r = (await loadCalgary311()) as { rows: Row311[]; fetchedAt: string; sites?: Record<string, Site> };
      if (r.sites) { await loadCity(); for (const [id, s] of Object.entries(r.sites)) city?.prime(id, s); }
      live = loadLive311(r.rows, r.fetchedAt);
      liveFetched = Date.now();
      liveVersion++;
      say({ live: "ready" });
    } catch (e) {
      liveP = null;
      say({ live: "error", liveError: e instanceof Error ? e.message : String(e) });
    }
  })());
}

// ------------------------------------------------------------ requests
function routesFor(plan: Plan311, at: "morning" | "noon", order: Record<string, number[]>) {
  const out: Record<string, CrewRoute> = {};
  if (!roads) return out;
  const view = at === "noon" && plan.noon ? plan.noon : plan.morning;
  view.routes.forEach((jobs, crew) => {
    if (!jobs.length) return;
    const o = order[crew]?.length === jobs.length ? order[crew] : undefined;
    out[crew] = routeStops(roads!, DEPOT, jobs, o);
  });
  return out;
}

/** A plan without the parts that can't (or needn't) cross to the main thread. */
function portable(p: Plan311): Plan311 {
  const strip = (c: Plan311["ctx"]) => ({ ...c, city: null, roadAt: null });
  return { ...p, ctx: strip(p.ctx), noonCtx: strip(p.noonCtx) };
}

/**
 * The week, worked day by day: day d plans what's still open after days 0..d-1 were done, with
 * day d's forecast and every ticket d days older. The noon disruption is today's. Cached per
 * settings, so switching days is instant; days are filled in the background after the one asked for.
 */
let week: { key: string; loads: Load311[]; plans: Plan311[]; summary: DaySummary[] } | null = null;
let latest = 0;

function weekKey(m: Extract<ToWorker, { type: "plan" }>, version: number) {
  const o = m.opts;
  return JSON.stringify([m.source, version, o.roads, o.waste, o.perCrew, o.disruption, o.overrides, o.weatherDays, !!city, !!roads]);
}

function planDay(m: Extract<ToWorker, { type: "plan" }>, base0: Load311, d: number): Plan311 {
  const w = week!;
  if (w.plans[d]) return w.plans[d];
  for (let i = w.plans.length; i <= d; i++) {
    const load = i === 0 ? base0 : nextDay(w.loads[i - 1], w.plans[i - 1]);
    const weather = m.opts.weatherDays[i] ?? null;
    const plan = plan311(load, {
      roads: m.opts.roads, waste: m.opts.waste, perCrew: m.opts.perCrew, overrides: m.opts.overrides,
      disruption: i === 0 ? m.opts.disruption : "none", weather, city, roadAt: roads ? (la, ln) => roads!.roadAt(la, ln) : null,
    });
    w.loads[i] = load;
    w.plans[i] = plan;
    w.summary[i] = summarize(plan, i, weather);
  }
  return w.plans[d];
}

async function plan(m: Extract<ToWorker, { type: "plan" }>) {
  latest = m.id;
  await Promise.all([loadCity(), m.source === "live" ? loadLive() : loadSample()]);
  if (m.id !== latest) return; // a newer request came in while loading
  const load = m.source === "live" ? live : sample;
  if (!load) return;
  const t0 = performance.now();
  const version = m.source === "live" ? liveVersion : sampleVersion;
  const key = weekKey(m, version);
  if (week?.key !== key) week = { key, loads: [], plans: [], summary: [] };
  const day = Math.min(SCHEDULE_DAYS - 1, Math.max(0, m.day));
  say({ scoring: !week.plans[day] });
  const p = planDay(m, load, day);
  lastPlan = { plan: p, at: m.at };
  // The ticket set travels once per version, or whenever the panel says it doesn't have it.
  const loadInfo = !m.needLoad && sent.get(m.source) === version ? null : { source: m.source, version, load };
  sent.set(m.source, version);
  post({ type: "plan", id: m.id, day, plan: portable(p), routes: routesFor(p, m.at, m.routeOrder), load: loadInfo, schedule: [...week.summary], ms: Math.round(performance.now() - t0) });
  say({ scoring: false });
  // Fill in the rest of the week, a day at a time, unless something newer comes in.
  const fill = () => {
    if (m.id !== latest || week?.key !== key) return;
    const next = week.plans.length;
    if (next >= SCHEDULE_DAYS) return;
    planDay(m, load, next);
    post({ type: "schedule", schedule: [...week.summary] });
    setTimeout(fill, 0);
  };
  setTimeout(fill, 0);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === "init") {
    base = m.base;
    void loadCity();
    void loadRoads();
  } else if (m.type === "plan") void plan(m);
  else if (m.type === "refresh") void loadLive(true);
  else if (m.type === "shortest") {
    if (!lastPlan || !roads) { post({ type: "shortest", id: m.id, order: [] }); return; }
    const view = lastPlan.at === "noon" && lastPlan.plan.noon ? lastPlan.plan.noon : lastPlan.plan.morning;
    post({ type: "shortest", id: m.id, order: shortestOrder(roads, DEPOT, view.routes.get(m.crew) ?? []) });
  }
};
