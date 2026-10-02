/**
 * Engine glue: boots the worker + scene, loads every workspace region, pulls
 * open data, and wires the scene to app state. The only module that knows
 * about all layers.
 */
import { PROJECTION, type Region } from "./config/regions";
import { fetchHotspots, fetchPerimeters } from "./data/cwfis";
import { buildSnapshot, simulatedHotspots } from "./data/hazards";
import { fetchWeatherGrid, type WeatherGrid } from "./data/openMeteo";
import type { Place } from "./data/places";
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
/**
 * Weather changes slowly and Open-Meteo's free tier is ~10k point-lookups/day, so: only regions
 * IN FOCUS get live weather, each refreshed at most hourly (unfocused ones still get fires + fuel risk).
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
      app.set({ loaded: [], places: [], hotspots: [], perimeters: [], weather: [], selected: null, hover: null });
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
    // Replace (never append) this region's entries so a reload can't duplicate them.
    app.set((s) => ({
      loaded: [...s.loaded.filter((id) => id !== region.id), region.id],
      places: [...s.places.filter((p) => p.region !== index), ...places.map((p) => ({ ...p, region: index }))],
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
    const [hs, per, ...wx] = await Promise.allSettled([
      fetchHotspots(box), fetchPerimeters(box),
      ...loaded.filter((r) => app.get().focus.includes(r.id)).map(async (r) => {
        const c = this.weatherCache.get(r.id);
        if (c && now - c.at < WEATHER_TTL_MS) return c.grid;
        const grid = await fetchWeatherGrid(r.bbox);
        this.weatherCache.set(r.id, { at: now, grid });
        return grid;
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
        at: new Date().toISOString(),
      },
    });
    await this.pushHazards();
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
    await this.client.setHazards(buildSnapshot({
      hotspots, perimeters: s.perimeters, weather: s.weather, weatherBoost: s.simulation ? 1.35 : 1,
    }));
    await this.scene.world.refreshStatus();
    const beacons = await Promise.all(hotspots.map(async (h) => {
      const w = project(h.lat, h.lng);
      const smp = await this.client.sample(w.x, w.z);
      return { x: w.x, z: w.z, elev: smp.elevation, simulated: h.agency === "SIMULATION" };
    }));
    this.scene.setBeacons(app.get().layers.beacons ? beacons : []);
  }

  setSimulation(on: boolean) {
    app.set({ simulation: on });
    void this.pushHazards();
  }

  // ------------------------------------------------------------ view options
  setTheme(theme: Theme) {
    app.set({ theme });
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("embergrid.theme", theme); } catch { /* storage unavailable */ }
    this.scene?.setTheme(theme);
  }

  setLabelMode(mode: LabelMode) {
    app.set({ labelMode: mode });
    this.scene?.setLabelMinPop(LABEL_MIN_POP[mode]);
  }

  setLayer(key: keyof Layers, on: boolean) {
    app.set((s) => ({ layers: { ...s.layers, [key]: on } }));
    this.applyLayers(app.get().layers);
    if (key === "beacons") void this.pushHazards();
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
