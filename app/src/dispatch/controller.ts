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
import { load311, plan311 } from "./ops311";
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
export function recompute311() {
  const d = dispatch.get();
  if (!d.load311) return;
  dispatch.set({ plan311: plan311(d.load311, { roads: d.roads, waste: d.waste, perCrew: d.perCrew, disruption: d.disruption }) });
}

export function set311Options(patch: Partial<Pick<DispatchState, "roads" | "waste" | "perCrew" | "disruption" | "at">>) {
  dispatch.set(patch);
  void loadCases().then(recompute311);
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
  void loadCases().then(() => { if (dispatch.get().source === "live") recomputeCrews(); });
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
