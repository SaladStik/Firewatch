/**
 * Runs the dispatch cases against the app's data: loads the case tables, runs the improvement
 * round, keeps the crew plan and the 311 plan current, and (demo scenario) hands the engine the
 * case fires to put on the map.
 */
import { ACTIVE_BURN_MIN } from "../data/cffdrs";
import type { Hotspot } from "../data/cwfis";
import { CRITICAL_ASSETS } from "../data/criticalAssets";
import { weatherAt } from "../data/openMeteo";
import type { Engine } from "../engine";
import { activeFires, nearestPlaceText } from "../firefly/facts";
import { snapshot } from "../firefly/tools";
import { project } from "../geo/projection";
import { app } from "../state/app";
import { FUEL_FOR_LAND } from "../world/fireGrowth";
import { exposures, HAND_WEIGHTS, learnWeights, loadHistory, planCrews, type CrewFire, type PlaceLite, type RankInput, type Scored } from "./crews";
import { AIR_ROS, dispatchFleet, LAKE_MAX_KM, makeFleet, type Lake } from "./fleet";
import { loadAircraft, usingDataServer } from "../data/liveData";
import { unproject } from "../geo/projection";
import { SCHEDULE_DAYS, type Override, type Weather311 } from "./ops311";
import type { FromWorker, ToWorker } from "./plan311.worker";
import { dispatch, type DispatchState } from "./store";

let engine: Engine | null = null;
const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
const assets = CRITICAL_ASSETS.map((a) => ({ name: a.name, kind: a.kind, lat: a.lat, lng: a.lng }));

/** Hook the dispatch cases up to the engine (once, after boot). */
export function initDispatch(e: Engine) {
  engine = e;
  let lastTab = dispatch.get().tab, lastOpen = dispatch.get().open;
  dispatch.subscribe(() => {
    const d = dispatch.get();
    if (d.tab === lastTab && d.open === lastOpen) return;
    lastTab = d.tab; lastOpen = d.open;
    if (d.open && d.tab === "crews") void pollAircraft();
  });
  // The forecast day drives the 311 schedule: switching days shows that day's plan.
  let lastDay = app.get().forecastDay;
  app.subscribe(() => {
    const day = app.get().forecastDay;
    if (day === lastDay) return;
    lastDay = day;
    dispatch.set({ cursor311: 0, dispatched: {}, routeOrder: {} });
    if (dispatch.get().open && dispatch.get().tab === "311") void recompute311();
  });
  // Live fires change with every data refresh: keep the live plan current.
  let lastKey = "";
  app.subscribe(() => {
    const s = app.get(), d = dispatch.get();
    const key = `${s.dataStatus.at}|${s.forecastDay}|${s.hotspots.length}|${s.perimeters.length}|${s.weather.length}`;
    if (key === lastKey) return;
    lastKey = key;
    if (d.source === "live" && d.open) recomputeCrews();
  });
}

// ------------------------------------------------------------ loading
let loading: Promise<void> | null = null;

/** Load both case tables (once). The improvement round runs right after, off the click. */
export function loadCases(): Promise<void> {
  if (loading) return loading;
  dispatch.set({ status: "loading", error: "" });
  loading = (async () => {
    try {
      const [fires, places] = await Promise.all([
        fetch(`${base()}data/cases/alberta_wildfires_2023_2025.csv`).then((r) => r.text()),
        fetch(`${base()}data/alberta/places.json`).then((r) => r.json() as Promise<{ places: PlaceLite[] }>),
      ]);
      const history = loadHistory(fires);
      const historyInput: RankInput = { fires: history.fires, exposures: exposures(history.fires, places.places, assets) };
      dispatch.set({ history, historyInput, status: "learning" });
      // Let the panel paint "learning…" before the weight search (about a second).
      await new Promise((r) => setTimeout(r, 30));
      learn();
      dispatch.set({ status: "ready" });
    } catch (e) {
      loading = null;
      dispatch.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return loading;
}

function learn() {
  const d = dispatch.get();
  if (!d.historyInput) return;
  dispatch.set({ learned: learnWeights(d.historyInput, d.crews) });
  recomputeCrews();
}

// ------------------------------------------------------------ wildfire crews
/** Today's active fires as crew-ranking inputs: size, today's FWI and fuel at the fire, observed growth. */
export function liveFires(): CrewFire[] {
  const s = snapshot();
  const month = new Date().getMonth() + 1;
  return activeFires(s).map((f) => {
    const wx = weatherAt(s.weather, f.lat, f.lng)?.days[s.forecastDay];
    const w = project(f.lat, f.lng);
    const node = engine?.scene?.world.nodeAt(w.x, w.z);
    const fuel = (node && FUEL_FOR_LAND[node.land]) || "M-1";
    const per = f.id ? s.perimeters.find((p) => p.id === f.id) : undefined;
    const g = f.id ? s.fireGrowth[f.id] : undefined;
    return {
      id: f.fid,
      name: nearestPlaceText(s, f.lat, f.lng) ?? undefined,
      lat: f.lat,
      lng: f.lng,
      sizeHa: per?.areaHa ?? Math.max(1, Math.PI * f.r0 * f.r0 * 100),
      observedRos: g ? (g.observedKmDay * 1000) / ACTIVE_BURN_MIN : null,
      tempC: wx?.temp ?? 20,
      rh: wx?.rh ?? 40,
      windKmh: wx?.windNoon ?? wx?.wind ?? 10,
      month,
      fuel,
      fuelCode: fuel,
      crown: false,
      fwi: wx && Number.isFinite(wx.isi) ? { isi: wx.isi, bui: wx.bui } : undefined,
      imputed: wx ? [] : ["weather"],
    };
  });
}

function liveInput(): RankInput {
  const fires = liveFires();
  const places = app.get().places.filter((p) => !p.landmark);
  return { fires, exposures: exposures(fires, places, assets) };
}

export function recomputeCrews() {
  const d = dispatch.get();
  const weights = d.useLearned && d.learned?.kept ? d.learned.weights : HAND_WEIGHTS;
  let input: RankInput | null = null;
  if (d.source === "live") input = liveInput();
  else if (d.historyInput) {
    const fires = d.year ? d.historyInput.fires.filter((f) => f.year === d.year) : d.historyInput.fires;
    input = { fires, exposures: d.historyInput.exposures };
  }
  const plan = input && input.fires.length ? planCrews(input, d.crews, d.cutPct, weights) : null;
  dispatch.set({ plan });
  void recomputeFleet();
  if (app.get().simulation && d.source === "history") void engine?.pushHazards();
}

// ------------------------------------------------------------ wildfire dispatch (resources)
/** Nearest scoopable lake per fire (null: none within reach), looked up once. */
const lakes = new Map<string, Lake | null>();
const fireKey = (s: Scored) => `${s.fire.year ?? ""}:${s.fire.id}:${s.fire.lat.toFixed(3)},${s.fire.lng.toFixed(3)}`;
let fleetRun = 0;

/**
 * Send the fleet to the crewed fires (after the cut): ground crews follow the crew count (60 %
 * helitack, 40 % unit crews), aircraft are set in the panel. Skimmers need a lake near the fire.
 */
export async function recomputeFleet() {
  const run = ++fleetRun;
  const d = dispatch.get(), plan = d.plan;
  if (!plan) { dispatch.set({ fleetDispatch: [] }); return; }
  const fires = plan.pickedCut;
  const needAir = fires.filter((s) => (s.ros >= AIR_ROS || s.fire.crown) && !lakes.has(fireKey(s)));
  if (engine && needAir.length) {
    await Promise.all(needAir.map(async (s) => {
      const w = project(s.fire.lat, s.fire.lng);
      const hit = await engine!.findWater(w.x, w.z, LAKE_MAX_KM).catch(() => null);
      lakes.set(fireKey(s), hit ? { ...unproject(hit.x, hit.z), km: hit.km } : null);
    }));
  }
  if (run !== fleetRun) return;
  const fleet = fleetNow();
  dispatch.set({ fleetDispatch: dispatchFleet(fires, fleet, (s) => lakes.get(fireKey(s)) ?? null) });
}

/** Every resource at its base: ground crews follow the crews after the cut, aircraft the panel. */
export function fleetNow() {
  const d = dispatch.get(), ground = d.plan?.cutCrews ?? 0, helitack = Math.round(ground * 0.6);
  return makeFleet({ helitack, unit: ground - helitack, airtanker: d.airtankers, skimmer: d.skimmers });
}

export function setFleetOptions(patch: Partial<Pick<DispatchState, "airtankers" | "skimmers" | "showLiveAircraft" | "simulate">>) {
  dispatch.set(patch);
  if ("airtankers" in patch || "skimmers" in patch) void recomputeFleet();
  if (patch.showLiveAircraft) void pollAircraft();
}

// ------------------------------------------------------------ live aircraft
let aircraftTimer = 0;
/** Poll firefighting aircraft every minute while Dispatch is open on the wildfire tab. */
export async function pollAircraft() {
  clearTimeout(aircraftTimer);
  const d = dispatch.get();
  if (!d.open || d.tab !== "crews" || !d.showLiveAircraft) return;
  if (!usingDataServer) { dispatch.set({ aircraftStatus: "no-server" }); return; }
  if (!d.liveAircraft.length) dispatch.set({ aircraftStatus: "loading" });
  try {
    const r = await loadAircraft();
    if (r) dispatch.set({ liveAircraft: r.aircraft, aircraftAt: r.fetchedAt, aircraftStatus: "ready" });
  } catch {
    dispatch.set({ aircraftStatus: "error" });
  }
  aircraftTimer = window.setTimeout(() => void pollAircraft(), 60_000);
}

/** Change crew settings (and re-run the improvement round if the crew count changed). */
export function setCrewOptions(patch: Partial<Pick<DispatchState, "source" | "crews" | "cutPct" | "year" | "useLearned" | "showCut">>) {
  const before = dispatch.get();
  dispatch.set(patch);
  if (patch.source === "history" || (patch.crews !== undefined && patch.crews !== before.crews)) void loadCases().then(() => (patch.crews !== undefined ? learn() : recomputeCrews()));
  else recomputeCrews();
}

// ------------------------------------------------------------ Calgary 311 (planned in a worker)
/**
 * Everything heavy for 311 (the ~25,000-ticket live queue, scoring, assignment, street routing)
 * runs in dispatch/plan311.worker.ts. The panel asks for a plan; the newest answer wins.
 */
let worker: Worker | null = null;
let reqId = 0;
const waiting = new Map<number, () => void>();
const shortestWaiting = new Map<number, (o: number[]) => void>();
let roadsWere = "idle", cityWas = false;

function planner(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./plan311.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === "status") {
      dispatch.set({ liveStatus: m.live, liveError: m.liveError, cityReady: m.city, roadStatus: m.roads, scoring311: m.scoring });
      // Newly loaded street network / context: re-score (road classes, sites), then route.
      if ((m.roads === "ready" && roadsWere !== "ready") || (m.city && !cityWas)) { roadsWere = m.roads; cityWas = m.city; void recompute311(); }
      roadsWere = m.roads; cityWas = m.city;
    } else if (m.type === "schedule") {
      dispatch.set({ schedule311: m.schedule });
    } else if (m.type === "plan") {
      dispatch.set({ schedule311: m.schedule });
      // The ticket set travels once per version: keep it even if a newer plan request superseded this one.
      if (m.load && m.load.source === dispatch.get().source311) dispatch.set({ load311: m.load.load });
      if (m.id !== reqId) return; // superseded: the newest request's answer resolves everyone
      dispatch.set({ plan311: m.plan, routes: m.routes, planMs: m.ms, plan311Error: "" });
      // Resolve every caller once the plan on screen is the newest one (the worker drops
      // requests a newer one superseded, so their callers wait for that one's answer).
      for (const resolve of waiting.values()) resolve();
      waiting.clear();
    } else if (m.type === "failed") {
      if (m.id !== reqId) return;
      dispatch.set({ plan311Error: m.error });
      for (const resolve of waiting.values()) resolve();
      waiting.clear();
    } else if (m.type === "shortest") {
      shortestWaiting.get(m.id)?.(m.order);
      shortestWaiting.delete(m.id);
    }
  };
  worker.postMessage({ type: "init", base: new URL(base(), location.href).href } satisfies ToWorker);
  return worker;
}

/** Re-plan the day (and its routes) with the panel's settings. Resolves when the plan arrives. */
export function recompute311(keepOrder = false): Promise<void> {
  const d = dispatch.get();
  const id = ++reqId;
  if (!keepOrder && Object.keys(d.routeOrder).length) dispatch.set({ routeOrder: {} });
  const msg: ToWorker = {
    type: "plan", id, source: d.source311, at: d.at, routeOrder: keepOrder ? d.routeOrder : {}, day: app.get().forecastDay,
    needLoad: !d.load311 || d.load311.source !== d.source311,
    opts: { roads: d.roads, waste: d.waste, perCrew: d.perCrew, disruption: d.disruption, overrides: d.overrides, weatherDays: Array.from({ length: SCHEDULE_DAYS }, (_, i) => calgaryWeather(i)) },
  };
  return new Promise((resolve) => { waiting.set(id, resolve); planner().postMessage(msg); });
}

/**
 * Replan 311 and wait for it (at most `timeoutMs`); throws with the reason when there's no plan,
 * so Firefly says why instead of waiting forever.
 */
export async function plan311Now(timeoutMs = 30_000) {
  await Promise.race([recompute311(), new Promise((r) => setTimeout(r, timeoutMs))]);
  const d = dispatch.get();
  if (!d.plan311 || !d.load311) throw new Error(d.plan311Error || "The 311 plan is still loading. Try again in a moment.");
  return d.plan311;
}

/** Re-route the plan on screen (stop order changed, or 8 a.m. / noon switched). */
export const recomputeRoutes = () => recompute311(true);

/** Show day `d` of the schedule: moves the map's forecast day too, so the two stay in step. */
export function setDay311(d: number) {
  void engine?.setForecastDay(d);
}

/** Plan the live queue or the case sample. */
export function setSource311(source: "live" | "sample") {
  dispatch.set({ source311: source, routeOrder: {}, cursor311: 0, dispatched: {}, plan311: null, routes: {}, load311: null });
  void recompute311();
}

/** Fetch the live queue again now (the data server refreshes it every 10 minutes anyway). */
export function refreshLive311() {
  planner().postMessage({ type: "refresh" } satisfies ToWorker);
  void recompute311();
}

/** Re-order one crew's stops for the least driving (or back to priority order). Resolves to the minutes saved. */
export async function setShortestOrder(crew: string, on: boolean): Promise<number> {
  const d = dispatch.get();
  const before = d.routes[crew]?.minutes ?? 0;
  const next = { ...d.routeOrder };
  if (on) {
    const id = ++reqId;
    next[crew] = await new Promise<number[]>((resolve) => { shortestWaiting.set(id, resolve); planner().postMessage({ type: "shortest", id, crew } satisfies ToWorker); });
  } else delete next[crew];
  dispatch.set({ routeOrder: next });
  await recompute311(true);
  return before - (dispatch.get().routes[crew]?.minutes ?? before);
}

/** Dispatcher override on one ticket (null clears it); the day is replanned at once. */
export function setOverride(id: string, o: Override | null) {
  const next = { ...dispatch.get().overrides };
  if (o) next[id] = o; else delete next[id];
  dispatch.set({ overrides: next });
  void recompute311();
}

export function openTickets(open = true) {
  dispatch.set({ ticketsOpen: open });
  if (open && !dispatch.get().plan311) void recompute311();
}

export function set311Options(patch: Partial<Pick<DispatchState, "roads" | "waste" | "perCrew" | "disruption" | "at">>) {
  const onlyView = Object.keys(patch).every((k) => k === "at");
  dispatch.set(patch);
  void recompute311(false);
  void onlyView;
}

/** Calgary's weather today from the map's forecast (null until it loads). */
export function calgaryWeather(dayIndex = 0): Weather311 | null {
  const days = weatherAt(app.get().weather, 51.045, -114.06)?.days;
  const day = (i: number): Weather311 | null => {
    const wx = days?.[i];
    if (!wx || !Number.isFinite(wx.temp)) return null;
    return { tempC: wx.temp, precipMm: Number.isFinite(wx.rainMm) ? wx.rainMm : 0, windKmh: Number.isFinite(wx.wind) ? wx.wind : 0 };
  };
  const today = day(dayIndex);
  return today ? { ...today, tomorrow: day(dayIndex + 1) } : null;
}

/**
 * The disruption our own forecast suggests for Calgary: snow in the next two days → blizzard plan.
 * Null when the weather isn't loaded or no snow is coming.
 */
export function calgarySnowForecast(): { day: number; mm: number } | null {
  const s = app.get();
  for (let day = 0; day <= 2; day++) {
    const wx = weatherAt(s.weather, 51.045, -114.06)?.days[day];
    if (wx && wx.rainMm >= 1 && wx.temp <= 2) return { day, mm: wx.rainMm };
  }
  return null;
}

// ------------------------------------------------------------ panel and map
export function openDispatch(tab?: DispatchState["tab"]) {
  dispatch.set({ open: true, ...(tab ? { tab } : {}) });
  // 311 plans in its worker straight away; the wildfire table loads alongside.
  if ((tab ?? dispatch.get().tab) === "311" && !dispatch.get().plan311) void recompute311();
  void loadCases().then(() => { if (dispatch.get().source === "live") recomputeCrews(); });
  void pollAircraft();
}

export function closeDispatch() {
  dispatch.set({ open: false });
}

export function flyTo(lat: number, lng: number, km = 40) {
  engine?.flyToLatLng(lat, lng, km);
}

/**
 * Demo scenario: the case fires go on the map in place of invented ones — every fire on our crew
 * list and the baseline's (a few hotspots each, spread over the fire's size), labelled as a replay.
 * Null before the case table has loaded (the engine then falls back to its invented demo fires).
 */
export function caseHotspots(): Hotspot[] | null {
  const d = dispatch.get();
  const plan = d.source === "history" ? d.plan : null;
  if (!plan) return null;
  const shown = new Map<string, CrewFire>();
  for (const s of [...plan.picked, ...plan.baseline.slice(0, plan.crews)]) shown.set(`${s.fire.year}:${s.fire.id}`, s.fire);
  const out: Hotspot[] = [];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const now = new Date().toISOString();
  for (const f of shown.values()) {
    const rKm = Math.sqrt(f.sizeHa / 100 / Math.PI);
    const n = Math.max(1, Math.min(8, Math.round(1 + Math.log10(1 + f.sizeHa) * 2)));
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, r = k === 0 ? 0 : rKm * Math.sqrt(rnd());
      out.push({
        id: `case-${f.year}-${f.id}-${k}`,
        lat: f.lat + (r * Math.sin(a)) / 111,
        lng: f.lng + (r * Math.cos(a)) / (111 * Math.cos((f.lat * Math.PI) / 180)),
        time: now, frp: 50 + f.sizeHa / 10, fwi: 20, hfi: 5000, fuel: f.fuelCode, sensor: `AB ${f.year} ${f.id}`, agency: "SIMULATION",
      });
    }
  }
  return out;
}
