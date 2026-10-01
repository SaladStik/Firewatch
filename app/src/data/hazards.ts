/**
 * Merges every hazard source into one projected HazardSnapshot for the worker.
 * Add a new source: fetch it, then push into hotspots/perimeters/weather here.
 */
import { project } from "../geo/projection";
import { downwind } from "../world/spread";
import type { HazardSnapshot } from "../world/types";
import type { Hotspot, Perimeter } from "./cwfis";
import { weatherAt, type WeatherGrid } from "./openMeteo";

export interface HazardInputs {
  hotspots: Hotspot[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  /** Forecast day index into each cell's `days` (0 = now). */
  day: number;
  /** Demo scenario: multiplies weather risk (1 = real data). */
  weatherBoost: number;
}

const ACTIVE_PERIMETER_DAYS = 5;

export function isPerimeterActive(p: Perimeter, now = Date.now()) {
  return now - Date.parse(p.lastDate) < ACTIVE_PERIMETER_DAYS * 86_400_000;
}

export function buildSnapshot(inp: HazardInputs): HazardSnapshot {
  const now = Date.now();
  return {
    hotspots: inp.hotspots.map((h) => {
      // Nearest weather cell; outside every grid or missing wind → calm (plain circle).
      const wx = weatherAt(inp.weather, h.lat, h.lng)?.days[inp.day];
      const calm = !wx || !Number.isFinite(wx.windFrom) || !Number.isFinite(wx.wind);
      return { ...project(h.lat, h.lng), frp: h.frp, fwi: h.fwi, ...downwind(calm ? 0 : wx.windFrom, calm ? 0 : wx.wind) };
    }),
    perimeters: inp.perimeters.map((p) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      const rings = p.rings.map((ring) => {
        const flat: number[] = [];
        for (const [lng, lat] of ring) {
          const w = project(lat, lng);
          flat.push(w.x, w.z);
          minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x);
          minZ = Math.min(minZ, w.z); maxZ = Math.max(maxZ, w.z);
        }
        return flat;
      });
      return { active: isPerimeterActive(p, now), minX, maxX, minZ, maxZ, rings };
    }),
    weather: inp.weather.map((w) => ({
      lat0: w.lat0, lng0: w.lng0, step: w.step, nLat: w.nLat, nLng: w.nLng,
      risk: w.cells.map((c) => Math.min(1, (c.days[inp.day]?.risk ?? 0) * inp.weatherBoost)),
    })),
  };
}

// ------------------------------------------------------------ demo scenario
/** Synthetic ignitions for demos (clearly flagged in the UI as SIMULATED). */
export function simulatedHotspots(sites: [string, number, number][], seed = 1): Hotspot[] {
  const out: Hotspot[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (const [name, lat, lng] of sites) {
    const n = 6 + Math.floor(rnd() * 10);
    for (let k = 0; k < n; k++) {
      out.push({
        id: `sim-${name}-${k}`,
        lat: lat + (rnd() - 0.5) * 0.12, lng: lng + (rnd() - 0.5) * 0.2,
        time: new Date().toISOString(), frp: 20 + rnd() * 180, fwi: 25 + rnd() * 20, hfi: 4000 + rnd() * 20000,
        fuel: "C2", sensor: "SIM", agency: "SIMULATION",
      });
    }
  }
  return out;
}
