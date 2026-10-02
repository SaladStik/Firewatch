/**
 * Merges every hazard source into one projected HazardSnapshot for the worker.
 * Add a new source: fetch it, then push into hotspots/perimeters/weather here.
 */
import { project } from "../geo/projection";
import { downwind } from "../world/spread";
import type { HazardSnapshot } from "../world/types";
import type { Hotspot, Perimeter } from "./cwfis";
import { perimeterAt, reachScale, type FireGrowth } from "./fireHistory";
import type { GrowthField } from "../world/fireGrowth";
import type { RainBlob } from "./rain";
import { weatherAt, type WeatherGrid } from "./openMeteo";

export interface HazardInputs {
  hotspots: Hotspot[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  /** Forecast day index into each cell's `days` (0 = today). */
  day: number;
  /** Demo scenario: multiplies weather risk (1 = real data). */
  weatherBoost: number;
  /** Projected burn from the fuel-aware growth model (world/fireGrowth.ts). */
  spread: GrowthField | null;
  /** Demo-scenario rain cells for the selected day (data/rain.ts). */
  rain: RainBlob[];
  /** Per-fire growth calibration by perimeter id (data/fireHistory.ts). */
  growth?: Record<string, FireGrowth>;
}

const ACTIVE_PERIMETER_DAYS = 5;
/** Demo scenario: heatwave multiplier on weather risk. */
export const SIM_WEATHER_BOOST = 1.35;

export function isPerimeterActive(p: Perimeter, now = Date.now()) {
  return now - Date.parse(p.lastDate) < ACTIVE_PERIMETER_DAYS * 86_400_000;
}

export function buildSnapshot(inp: HazardInputs): HazardSnapshot {
  const now = Date.now();
  const calibrated = inp.perimeters.filter((p) => inp.growth?.[p.id] && isPerimeterActive(p, now));
  return {
    hotspots: inp.hotspots.map((h) => {
      // Nearest weather cell; outside every grid or missing wind → calm (plain circle).
      const wx = weatherAt(inp.weather, h.lat, h.lng)?.days[inp.day];
      const calm = !wx || !Number.isFinite(wx.windFrom) || !Number.isFinite(wx.wind);
      // A hotspot on a fire with known growth reaches further / less far, like that fire has been.
      const fire = calibrated.length ? perimeterAt(calibrated, h.lat, h.lng) : undefined;
      const scale = fire ? reachScale(inp.growth![fire.id].k) : 1;
      return { ...project(h.lat, h.lng), frp: h.frp, fwi: h.fwi, ...downwind(calm ? 0 : wx.windFrom, calm ? 0 : wx.wind), scale };
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
    spread: inp.spread,
    rain: inp.rain,
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
