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
import { exposures, HAND_WEIGHTS, learnWeights, loadHistory, planCrews, type CrewFire, type PlaceLite, type RankInput } from "./crews";
import { DEPOT, load311, plan311, type Override, type Weather311 } from "./ops311";
import { RoadGraph, routeStops, shortestOrder } from "./router";
import { dispatch, type DispatchState } from "./store";

let engine: Engine | null = null;
const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
const assets = CRITICAL_ASSETS.map((a) => ({ name: a.name, kind: a.kind, lat: a.lat, lng: a.lng }));

/** Hook the dispatch cases up to the engine (once, after boot). */
export function initDispatch(e: Engine) {
  engine = e;
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
      const [fires, tickets, places] = await Promise.all([
        fetch(`${base()}data/cases/alberta_wildfires_2023_2025.csv`).then((r) => r.text()),
        fetch(`${base()}data/cases/calgary_311_sample.csv`).then((r) => r.text()),
        fetch(`${base()}data/alberta/places.json`).then((r) => r.json() as Promise<{ places: PlaceLite[] }>),
      ]);
      const history = loadHistory(fires);
      const historyInput: RankInput = { fires: history.fires, exposures: exposures(history.fires, places.places, assets) };
      dispatch.set({ history, historyInput, load311: load311(tickets), status: "learning" });
      recompute311();
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
  if (app.get().simulation && d.source === "history") void engine?.pushHazards();
}

/** Change crew settings (and re-run the improvement round if the crew count changed). */
export function setCrewOptions(patch: Partial<Pick<DispatchState, "source" | "crews" | "cutPct" | "year" | "useLearned" | "showCut">>) {
  const before = dispatch.get();
  dispatch.set(patch);
  if (patch.source === "history" || (patch.crews !== undefined && patch.crews !== before.crews)) void loadCases().then(() => (patch.crews !== undefined ? learn() : recomputeCrews()));
  else recomputeCrews();
}

// ------------------------------------------------------------ Calgary 311
// ------------------------------------------------------------ route planner
/** Calgary's street network (built once from the map's OpenStreetMap line tiles). */
let roads: RoadGraph | null = null;
let roadsLoading: Promise<void> | null = null;
const CALGARY_ROADS: [number, number, number, number] = [-114.40, 50.80, -113.80, 51.26];

function loadRoads(): Promise<void> {
  if (roadsLoading) return roadsLoading;
  dispatch.set({ roadStatus: "loading" });
  roadsLoading = (async () => {
    try {
      const url = `${base()}data/alberta/lines`;
      const index = (await (await fetch(`${url}/index.json`)).json()) as { q: number; tiles: string[] };
      const names: string[] = [];
      for (let la = Math.floor(CALGARY_ROADS[1]); la <= Math.floor(CALGARY_ROADS[3]); la++) for (let ln = Math.floor(CALGARY_ROADS[0]); ln <= Math.floor(CALGARY_ROADS[2]); ln++) names.push(`${la}_${ln}`);
      const tiles = await Promise.all(names.filter((n) => index.tiles.includes(n)).map((n) => fetch(`${url}/${n}.json`).then((r) => r.json())));
      await new Promise((r) => setTimeout(r, 20)); // let "Loading streets…" paint before the build (~0.7 s)
      roads = new RoadGraph(tiles, index.q, CALGARY_ROADS);
      dispatch.set({ roadStatus: "ready" });
      recomputeRoutes();
    } catch {
      roadsLoading = null;
      dispatch.set({ roadStatus: "error" });
    }
  })();
  return roadsLoading;
}

/** Route every crew on the plan on screen (8 a.m. or noon), in the order the dispatcher chose. */
export function recomputeRoutes() {
  const d = dispatch.get(), p = d.plan311;
  if (!p) return;
  if (!roads) { void loadRoads(); return; }
  const view = d.at === "noon" && p.noon ? p.noon : p.morning;
  const routes: DispatchState["routes"] = {};
  view.routes.forEach((jobs, crew) => {
    if (!jobs.length) return;
    const order = d.routeOrder[crew]?.length === jobs.length ? d.routeOrder[crew] : undefined;
    routes[crew] = routeStops(roads!, DEPOT, jobs, order);
  });
  dispatch.set({ routes });
}

/** Re-order one crew's stops for the least driving (or back to priority order). Returns the time saved (min). */
export function setShortestOrder(crew: string, on: boolean): number {
  const d = dispatch.get(), p = d.plan311;
  if (!p || !roads) return 0;
  const view = d.at === "noon" && p.noon ? p.noon : p.morning;
  const jobs = view.routes.get(crew) ?? [];
  const next = { ...d.routeOrder };
  if (on) next[crew] = shortestOrder(roads, DEPOT, jobs); else delete next[crew];
  const before = d.routes[crew]?.minutes ?? 0;
  dispatch.set({ routeOrder: next });
  recomputeRoutes();
  return before - (dispatch.get().routes[crew]?.minutes ?? before);
}

export function recompute311() {
  const d = dispatch.get();
  if (!d.load311) return;
  // A new plan changes the crews' jobs: chosen stop orders no longer apply.
  dispatch.set({ plan311: plan311(d.load311, { roads: d.roads, waste: d.waste, perCrew: d.perCrew, disruption: d.disruption, overrides: d.overrides, weather: calgaryWeather() }), routeOrder: {} });
  if (d.open && d.tab === "311") recomputeRoutes();
}

/** Dispatcher override on one ticket (null clears it); the day is replanned at once. */
export function setOverride(id: string, o: Override | null) {
  const next = { ...dispatch.get().overrides };
  if (o) next[id] = o; else delete next[id];
  dispatch.set({ overrides: next });
  recompute311();
}

export function openTickets(open = true) {
  dispatch.set({ ticketsOpen: open });
  if (open) void loadCases();
}

export function set311Options(patch: Partial<Pick<DispatchState, "roads" | "waste" | "perCrew" | "disruption" | "at">>) {
  const onlyView = Object.keys(patch).every((k) => k === "at");
  dispatch.set(patch);
  // Switching 8 a.m. / noon only changes which plan is routed.
  if (onlyView) { dispatch.set({ routeOrder: {} }); recomputeRoutes(); return; }
  void loadCases().then(recompute311);
}

/** Calgary's weather today from the map's forecast (null until it loads). */
export function calgaryWeather(): Weather311 | null {
  const wx = weatherAt(app.get().weather, 51.045, -114.06)?.days[0];
  if (!wx || !Number.isFinite(wx.temp)) return null;
  return { tempC: wx.temp, precipMm: Number.isFinite(wx.rainMm) ? wx.rainMm : 0, windKmh: Number.isFinite(wx.wind) ? wx.wind : 0 };
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
  void loadCases().then(() => {
    if (dispatch.get().source === "live") recomputeCrews();
    if (dispatch.get().tab === "311") recomputeRoutes();
  });
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
