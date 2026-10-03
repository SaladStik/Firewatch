/**
 * Engine glue: boots the worker + scene, loads every workspace region, pulls
 * open data, and wires the scene to app state. The only module that knows
 * about all layers.
 */
import { PROJECTION, type Region } from "./config/regions";
import type { FwiStation, Hotspot, Perimeter } from "./data/cwfis";
import { makeFwiSeed } from "./data/fwiSeed";
import { loadFireHistory, loadHotspots, loadPerimeters, loadStations, loadWeather, usingDataServer } from "./data/liveData";
import { growthCalibration, type FireGrowth, type FireHistory } from "./data/fireHistory";
import { fireSources, growthSources } from "./data/fireSpread";
import { growthCellSize } from "./world/fireGrowth";
import { buildSnapshot, isPerimeterActive, SIM_WEATHER_BOOST, simulatedHotspots } from "./data/hazards";
import { FORECAST_DAYS, weatherAt, type WeatherGrid } from "./data/openMeteo";
import { demoStorms, RainField, type RainBlob } from "./data/rain";
import { WindField } from "./data/wind";
import type { Place } from "./data/places";
import { loadTraffic } from "./data/traffic";
import { project, setProjection } from "./geo/projection";
import { NodeStatus } from "./hex/nodeTypes";
import type { Landmark } from "./hex/overlayStyles";
import { resolveStyle } from "./render/nodeStyle";
import { Scene } from "./render/Scene";
import { app, focusIndices, LABEL_MIN_POP, regionIndex, type LabelMode, type Layers, type Theme } from "./state/app";
import { WorldClient } from "./world/WorldClient";
import type { HexNodeInfo } from "./world/types";

const RISK_STATUSES = new Set<number>([NodeStatus.Elevated, NodeStatus.High, NodeStatus.Extreme]);
const FIRE_STATUSES = new Set<number>([NodeStatus.Burning, NodeStatus.Perimeter, NodeStatus.Burned]);
const DATA_REFRESH_MS = 10 * 60 * 1000;
/** A fire's growth history is refetched at most this often (and only when its perimeter changed). */
const FIRE_HISTORY_TTL_MS = 60 * 60 * 1000;
/** Hotspots closer than this share one beacon. */
const BEACON_CLUSTER_KM = 8;
/**
 * Weather changes slowly and Open-Meteo's free tier is ~10k point-lookups/day (a 3-week
 * request counts as several calls per point), so: only regions IN FOCUS get live weather,
 * each refreshed at most hourly (unfocused ones still get fires + fuel risk).
 */
const WEATHER_TTL_MS = 60 * 60 * 1000;

export class Engine {
  scene!: Scene;
  private client = new WorldClient();
  private timer = 0;
  private disposed = false;
  private weatherCache = new Map<string, { at: number; grid: WeatherGrid }>();

  async boot(canvas: HTMLCanvasElement, overlay: HTMLDivElement) {
    const stage = (s: string, progress: number) => app.set({ boot: { stage: s, done: false, progress } });
    try {
      // Fresh boot (also after a dev hot-reload): nothing is loaded yet.
      app.set({ loaded: [], places: [], traffic: [], hotspots: [], perimeters: [], weather: [], selected: null, hover: null });
      setProjection(PROJECTION);
      await this.client.init(PROJECTION);
      this.scene = new Scene(canvas, overlay, this.client, { onHover: (n) => app.set({ hover: n }), onSelect: (n) => this.onSelect(n), onStats: (s) => app.set({ stats: s }) });
      this.setTheme(app.get().theme);
      this.applyLayers(app.get().layers);
      this.setLabelMode(app.get().labelMode);
      this.scene.world.hold = true; // build nothing until every region is in

      // Load every region behind the loading screen (focused ones first), then live data,
      // then wait for the first view's hexes — the app opens fully ready.
      const { regions, focus } = app.get();
      const order = [...regions].sort((a, b) => Number(focus.includes(b.id)) - Number(focus.includes(a.id)));
      const steps = order.length + 2; // regions + live data + first view
      for (let i = 0; i < order.length; i++) {
        const r = order[i];
        stage(`Loading ${r.name} (${i + 1}/${order.length})`, i / steps);
        try {
          await this.loadRegion(r);
        } catch (e) {
          console.warn(`[engine] ${r.name} unavailable (not baked yet?)`, e);
        }
        if (this.disposed) return;
        if (i === 0) { this.scene.setFocus(focusIndices()); this.scene.resetView(); }
      }
      this.scene.setFocus(focusIndices());
      stage("Fetching live fire + weather data", order.length / steps);
      await this.refreshData();
      if (this.disposed) return;
      stage("Building the map", (order.length + 1) / steps);
      this.scene.world.invalidate(); // safety: nothing stale / falsely "empty"
      this.scene.world.hold = false;
      await this.waitForFirstView();
      app.set({ boot: { stage: "Online", done: true, progress: 1 } });
      this.timer = window.setInterval(() => this.refreshData(), DATA_REFRESH_MS);
    } catch (e) {
      app.set({ boot: { stage: "Boot failed", done: false, error: String(e) } });
    }
  }

  /** Resolves once the visible chunks have finished building (or after 20 s, as a safety net). */
  private waitForFirstView() {
    return new Promise<void>((done) => {
      const t0 = performance.now();
      let quiet = 0;
      const check = () => {
        const s = app.get().stats;
        quiet = s && s.pending === 0 && s.hexes > 0 ? quiet + 1 : 0;
        if (quiet >= 3 || performance.now() - t0 > 20_000 || this.disposed) done();
        else setTimeout(check, 150);
      };
      check();
    });
  }

  private async loadRegion(region: Region) {
    const index = regionIndex(region.id);
    const url = `${import.meta.env.BASE_URL}data/${region.id}`;
    const { places, landmarks } = await loadPlaces(url, region.places, region.landmarks);
    const meta = await this.client.addRegion(url, index, landmarks);
    this.scene.addRegion(index, meta, places);
    // Baked highway volumes, where the province publishes them (data/traffic.ts).
    const traffic = await loadTraffic(url, index);
    // Replace (never append) this region's entries so a reload can't duplicate them.
    app.set((s) => ({
      loaded: [...s.loaded.filter((id) => id !== region.id), region.id],
      places: [...s.places.filter((p) => p.region !== index), ...places.map((p) => ({ ...p, region: index }))],
      traffic: [...s.traffic.filter((t) => t.region !== index), ...(traffic ? [traffic] : [])],
    }));
  }

  // ------------------------------------------------------------ focus
  setFocus(ids: string[]) {
    if (!ids.length) return;
    const added = ids.some((id) => !this.weatherCache.has(id));
    app.set({ focus: ids });
    this.scene.setFocus(focusIndices());
    if (added) void this.refreshData(); // newly focused region → fetch its weather
  }

  toggleFocus(id: string) {
    const f = app.get().focus;
    this.setFocus(f.includes(id) ? f.filter((x) => x !== id) : [...f, id]);
  }

  // ------------------------------------------------------------ data
  async refreshData() {
    app.set((s) => ({ dataStatus: { ...s.dataStatus, cwfis: "loading", weather: "loading" } }));
    const loaded = app.get().regions.filter((r) => app.get().loaded.includes(r.id));
    // One fire query covering every loaded region; weather per region.
    const box: [number, number, number, number] = [
      Math.min(...loaded.map((r) => r.bbox[0])), Math.min(...loaded.map((r) => r.bbox[1])),
      Math.max(...loaded.map((r) => r.bbox[2])), Math.max(...loaded.map((r) => r.bbox[3])),
    ];
    const now = Date.now();
    // Hotspots first: their CWFIS FWI codes seed the weather cells near fires.
    const [hs, per] = await Promise.allSettled([loadHotspots(box), loadPerimeters(box)]);
    // The data server seeds the FWI System itself; only direct mode needs the stations here.
    const seed = usingDataServer ? undefined : await this.fwiSeed(hs.status === "fulfilled" ? hs.value : []);
    const wx = await Promise.allSettled([
      ...loaded.filter((r) => app.get().focus.includes(r.id)).map(async (r) => {
        const c = this.weatherCache.get(r.id) ?? readStoredWeather(r.id);
        // The map's weather list is built from weatherCache, so a reload's stored copy must go in it too.
        if (c) this.weatherCache.set(r.id, c);
        if (c && now - c.at < WEATHER_TTL_MS) return c.grid;
        try {
          const grid = await loadWeather(r, seed);
          const entry = { at: now, grid };
          this.weatherCache.set(r.id, entry);
          storeWeather(r.id, entry);
          return grid;
        } catch (e) {
          if (c) return c.grid; // a stale forecast beats a province with no weather
          throw e;
        }
      }),
    ]);
    const hotspots = hs.status === "fulfilled" ? await this.tagRegion(hs.value, (h) => [h.lat, h.lng]) : app.get().hotspots;
    const perimeters = per.status === "fulfilled"
      ? await this.tagRegion(per.value, (p) => {
        const ring = p.rings[0] ?? [];
        const lng = ring.reduce((a, c) => a + c[0], 0) / Math.max(1, ring.length);
        const lat = ring.reduce((a, c) => a + c[1], 0) / Math.max(1, ring.length);
        return [lat, lng];
      })
      : app.get().perimeters;
    // Keep previously fetched grids for regions that are no longer in focus.
    const fresh = wx.flatMap((w) => (w.status === "fulfilled" ? [w.value] : []));
    void fresh;
    const weather = [...this.weatherCache.values()].map((c) => c.grid);
    app.set({
      hotspots, perimeters, weather: weather.length ? weather : app.get().weather,
      dataStatus: {
        cwfis: hs.status === "fulfilled" && per.status === "fulfilled" ? "ok" : "error",
        weather: wx.every((w) => w.status === "fulfilled") ? "ok" : "error",
        weatherError: wx.map((w) => (w.status === "rejected" ? String((w.reason as Error)?.message ?? w.reason) : "")).find(Boolean),
        at: new Date().toISOString(),
      },
    });
    await this.pushHazards();
    // Each active fire's own growth history, fetched in the background; re-score when it lands.
    void this.refreshFireHistory(perimeters).then((changed) => { if (changed) void this.pushHazards(); });
  }

  private stations: { at: number; list: FwiStation[] } | null = null;

  /** Seed for the FWI System from today's stations + hotspots (data/fwiSeed.ts). Stations refreshed at most hourly. */
  private async fwiSeed(hotspots: Hotspot[] = []) {
    const now = Date.now();
    if (!this.stations || now - this.stations.at > WEATHER_TTL_MS) {
      try { this.stations = { at: now, list: await loadStations() }; } catch { /* keep the old list / spin up from startup values */ }
    }
    return makeFwiSeed(this.stations?.list ?? [], hotspots);
  }

  /** Fire histories by perimeter id (re-fetched when the perimeter updates, at most hourly). */
  private fireHistory = new Map<string, { at: number; hist: FireHistory | null }>();

  /** Fetch hotspot histories for active perimeters in focused regions. Resolves true if any changed. */
  private async refreshFireHistory(perimeters: (Perimeter & { region?: number })[]): Promise<boolean> {
    const s = app.get(), now = Date.now();
    const focus = new Set(s.focus.map((id) => s.regions.findIndex((r) => r.id === id)));
    const todo = perimeters.filter((p) => {
      if (!isPerimeterActive(p, now) || p.region == null || !focus.has(p.region)) return false;
      const c = this.fireHistory.get(p.id);
      return !c || (c.hist?.lastDate !== p.lastDate && now - c.at > FIRE_HISTORY_TTL_MS);
    });
    let changed = false;
    // A few at a time: big fires return tens of thousands of archived detections.
    for (let i = 0; i < todo.length; i += 3) {
      await Promise.all(todo.slice(i, i + 3).map(async (p) => {
        try {
          this.fireHistory.set(p.id, { at: now, hist: await loadFireHistory(p) });
          changed = true;
        } catch { /* keep the old one (or none): the fire is projected with the plain model */ }
      }));
    }
    return changed;
  }

  /** Calibrate every fire with history against the weather that actually happened there. */
  private fireGrowth(): Record<string, FireGrowth> {
    const s = app.get(), out: Record<string, FireGrowth> = {};
    for (const p of s.perimeters) {
      const hist = this.fireHistory.get(p.id)?.hist;
      const ring = p.rings[0];
      if (!hist?.days.length || !ring?.length) continue;
      const lng = ring.reduce((a, c) => a + c[0], 0) / ring.length, lat = ring.reduce((a, c) => a + c[1], 0) / ring.length;
      const grid = s.weather.find((g) => weatherAt([g], lat, lng));
      const cell = grid && weatherAt([grid], lat, lng);
      if (!grid || !cell) continue;
      out[p.id] = growthCalibration(hist, cell.past, grid.pastDates);
    }
    return out;
  }

  /** Keep features inside a loaded region and tag them with its index. */
  private async tagRegion<T extends { region?: number }>(items: T[], latLng: (t: T) => [number, number]): Promise<T[]> {
    const tags = await Promise.all(items.map(async (it) => {
      const [lat, lng] = latLng(it);
      const w = project(lat, lng);
      return (await this.client.sample(w.x, w.z)).region;
    }));
    return items.flatMap((it, i) => (tags[i] < 0 ? [] : [{ ...it, region: tags[i] }]));
  }

  private allHotspots() {
    const s = app.get();
    if (!s.simulation) return s.hotspots;
    const sims = s.regions.flatMap((r, i) => simulatedHotspots(r.demoSites).map((h) => ({ ...h, region: i })));
    return [...s.hotspots, ...sims];
  }

  async pushHazards() {
    const s = app.get();
    const hotspots = this.allHotspots();
    const weatherBoost = s.simulation ? SIM_WEATHER_BOOST : 1;
    // Demo scenario: a rainstorm drifting downwind day by day (one per focused region's demo sites).
    const storms: RainBlob[][] = [];
    for (let d = 0; d <= s.forecastDay; d++) storms.push(s.simulation ? this.demoStorms(d) : []);
    const rain = storms[s.forecastDay];
    // Projected spread for every active fire (real, plus simulated ones in the demo scenario).
    // Each fire's own growth history scales how far it's projected to go (data/fireHistory.ts).
    const growth = this.fireGrowth();
    // Grow every active fire over the real fuel map, day by day up to the selected day (world/fireGrowth.ts).
    let spread = null;
    if (s.layers.spread) {
      const src = growthSources(fireSources(hotspots, s.perimeters, Date.now(), growth), s.weather, s.forecastDay, weatherBoost, (d) => storms[d] ?? []);
      if (src.length) spread = await this.client.growth(src, s.forecastDay, growthCellSize(src, s.forecastDay));
    }
    app.set({ spread, fireGrowth: growth });
    this.rainBlobs = rain;
    await this.client.setHazards(buildSnapshot({
      hotspots, perimeters: s.perimeters, weather: s.weather, day: s.forecastDay, weatherBoost, spread, rain, growth,
    }));
    await this.scene.world.refreshStatus();
    // The open sector panel shows status/risk from click time; re-read it for the new hazards.
    const sel = app.get().selected;
    if (sel) app.set({ selected: this.scene.world.getNode(sel.level, sel.q, sel.r) ?? sel });
    // One beacon per ~BEACON_CLUSTER_KM cell: beacons are additive, so a dense cluster of
    // hotspots stacked into one blinding glow.
    const cells = new Map<string, { x: number; z: number; simulated: boolean }>();
    for (const h of hotspots) {
      const w = project(h.lat, h.lng);
      const key = `${Math.floor(w.x / BEACON_CLUSTER_KM)},${Math.floor(w.z / BEACON_CLUSTER_KM)}`;
      if (!cells.has(key)) cells.set(key, { x: w.x, z: w.z, simulated: h.agency === "SIMULATION" });
    }
    const beacons = await Promise.all([...cells.values()].map(async (b) => ({ ...b, elev: (await this.client.sample(b.x, b.z)).elevation })));
    this.scene.setBeacons(app.get().layers.beacons ? beacons : []);
    this.pushWind();
    this.pushRain();
  }

  private rainBlobs: RainBlob[] = [];

  private demoStorms(day: number): RainBlob[] {
    const s = app.get();
    const sites = s.regions.filter((r) => s.focus.includes(r.id)).map((r) => r.demoSites);
    return demoStorms(sites, s.weather, day);
  }

  /** Rain animation for the selected day: real rain + demo storms. */
  private pushRain() {
    const s = app.get();
    // Rain drifts and leans with the same wind as the streamlines (even when the wind layer is hidden).
    this.scene.setRain(s.layers.rain ? new RainField(s.weather, s.forecastDay, this.rainBlobs) : null, new WindField(s.weather, s.forecastDay));
  }

  /** Wind streamlines for the selected day (today = live wind). */
  private pushWind() {
    const s = app.get();
    this.scene.setWind(s.layers.wind ? new WindField(s.weather, s.forecastDay) : null);
  }

  setSimulation(on: boolean) {
    app.set({ simulation: on });
    void this.pushHazards();
  }

  /** Re-score the map with forecast weather for `day` (0 = today, 1..7 ahead). */
  setForecastDay(day: number) {
    app.set({ forecastDay: day });
    void this.pushHazards();
  }

  // ------------------------------------------------------------ view options
  setTheme(theme: Theme) {
    app.set({ theme });
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("firewatch.theme", theme); } catch { /* storage unavailable */ }
    this.scene?.setTheme(theme);
  }

  setLabelMode(mode: LabelMode) {
    app.set({ labelMode: mode });
    this.scene?.setLabelMinPop(LABEL_MIN_POP[mode]);
  }

  setLayer(key: keyof Layers, on: boolean) {
    app.set((s) => ({ layers: { ...s.layers, [key]: on } }));
    this.applyLayers(app.get().layers);
    if (key === "beacons" || key === "spread") void this.pushHazards();
    if (key === "wind") this.pushWind();
    if (key === "rain") this.pushRain();
  }

  private applyLayers(l: Layers) {
    this.scene.setBloom(l.bloom);
    // Layer toggles are just a styler — the same hook apps can use to customise nodes.
    this.scene.world.setStyler(
      l.risk && l.fires
        ? null
        : (ctx) => {
          if ((!l.risk && RISK_STATUSES.has(ctx.status)) || (!l.fires && FIRE_STATUSES.has(ctx.status))) {
            return resolveStyle({ ...ctx, status: NodeStatus.Normal });
          }
        },
    );
  }

  // ------------------------------------------------------------ selection
  private async onSelect(n: HexNodeInfo | null) {
    // Clicking a greyed region brings it into focus.
    if (n && !focusIndices().includes(n.region)) {
      const id = app.get().regions[n.region]?.id;
      if (id) this.setFocus([...app.get().focus, id]);
    }
    app.set({ selected: n, selectedSample: null });
    if (!n) return;
    const sample = await this.client.sample(n.x, n.z);
    if (app.get().selected?.key === n.key) app.set({ selectedSample: sample });
  }

  flag(n: HexNodeInfo) {
    if (app.get().flagged.includes(n.key)) return;
    app.set((s) => ({ flagged: [...s.flagged, n.key] }));
    this.scene.world.setOverride(n.level, n.q, n.r, { line: "#7dd3ff", pulse: 0.6, lift: 0.15 });
  }

  flyToLatLng(lat: number, lng: number, dist = 25) {
    const w = project(lat, lng);
    this.scene.flyTo(w.x, w.z, dist);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.scene?.dispose();
    this.client.dispose();
  }
}

/** Weather survives page reloads for WEATHER_TTL_MS so demos and dev reloads don't burn Open-Meteo quota. */
const WX_KEY = (id: string) => `firewatch.wx.${id}`;
function readStoredWeather(id: string): { at: number; grid: WeatherGrid } | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(WX_KEY(id)) ?? "null");
    // Ignore entries written by an older data shape. Past days are required (fire-growth calibration).
    return v?.grid?.cells?.[0]?.days?.length === FORECAST_DAYS + 1 && v.grid.cells[0].now && "rain" in v.grid.cells[0].now && Number.isFinite(v.grid.cells[0].days[0]?.fwi) && "windNoon" in v.grid.cells[0].days[0] && v.grid.cells[0].past?.length && v.grid.pastDates?.length ? v : undefined;
  } catch { return undefined; }
}
function storeWeather(id: string, entry: { at: number; grid: WeatherGrid }) {
  try { localStorage.setItem(WX_KEY(id), JSON.stringify(entry)); } catch { /* storage full or unavailable */ }
}

/**
 * Community labels + landmark positions from the OSM bake (places.json).
 * Falls back to the region config when a region hasn't been baked yet.
 */
async function loadPlaces(dataUrl: string, fallback: Place[], landmarks: Landmark[]) {
  try {
    const r = await fetch(`${dataUrl}/places.json`);
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { places: Place[]; landmarks: Record<string, [number, number]> };
    const lm = landmarks.map((l) => (j.landmarks[l.name] ? { ...l, lat: j.landmarks[l.name][0], lng: j.landmarks[l.name][1] } : l));
    const lmPlaces: Place[] = lm.map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, pop: 0, landmark: true }));
    return { places: [...j.places, ...lmPlaces], landmarks: lm };
  } catch {
    return { places: fallback, landmarks };
  }
}
