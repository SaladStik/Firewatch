/**
 * Rain: how wet it is at a point (0..1), and how much that damps fire.
 *
 * Real rain comes from Open-Meteo (live precipitation for today, daily totals for the
 * forecast days). The demo scenario adds a rainstorm that drifts downwind day by day.
 * Both feed the same places: the risk score (hazardField), the spread model
 * (fireSpread) and the rain animation (RainParticles).
 */
import { project, unproject } from "../geo/projection";
import { downwind } from "../world/spread";
import { weatherAt, type WeatherGrid } from "./openMeteo";

/** A day with less rain than this (mm) shows no rain and isn't damped. */
export const RAIN_SHOW_MM_DAY = 1;
/** Daily total (mm) at which the rain animation is at full strength. */
const FULL_MM_DAY = 15;
/** Live rate (mm/h) at which today's animation is at full strength. */
const FULL_MM_HOUR = 4;

/**
 * Fire-weather multiplier for a day's rain total: wet fuels don't burn readily.
 * 0 mm → 1, 5 mm → ~0.44, 15 mm → ~0.21. (Our model; days-since-rain dryness is separate.)
 */
export function rainDamping(mmDay: number): number {
  if (!Number.isFinite(mmDay) || mmDay < RAIN_SHOW_MM_DAY) return 1;
  return 1 / (1 + mmDay / 4);
}

/** Rain intensity 0..1 for a daily total (mm). */
export function dayIntensity(mmDay: number): number {
  return Number.isFinite(mmDay) && mmDay >= RAIN_SHOW_MM_DAY ? Math.min(1, mmDay / FULL_MM_DAY) : 0;
}

/** Rain intensity 0..1 for a live rate (mm/h). */
export function nowIntensity(mmHour: number): number {
  return Number.isFinite(mmHour) && mmHour > 0.05 ? Math.min(1, 0.25 + mmHour / FULL_MM_HOUR) : 0;
}

/** A simulated rain cell in world km: full `intensity` at the centre, fading to 0 at `r`. */
export interface RainBlob {
  x: number;
  z: number;
  r: number;
  intensity: number;
}

/** Strongest blob intensity at a point (smooth falloff). */
export function blobRain(blobs: RainBlob[], x: number, z: number): number {
  let best = 0;
  for (const b of blobs) {
    const d = Math.hypot(x - b.x, z - b.z) / b.r;
    if (d < 1) best = Math.max(best, b.intensity * (1 - d * d) * (1 - d * d));
  }
  return best;
}

/** How much a demo-storm intensity (0..1) damps fire risk and spread. */
export function blobDamping(intensity: number): number {
  return 1 - 0.85 * intensity;
}

// ------------------------------------------------------------ demo storm
/** Demo storm radius (km), drift per day (km) and fade per day. */
const STORM_R_KM = 75;
const STORM_DRIFT_KM_DAY = 55;
const STORM_FADE_DAY = 0.08;

/**
 * The demo scenario's rainstorm for a forecast day: it starts over a demo fire site
 * (so its damping is visible) and drifts downwind with the real wind, weakening.
 */
export function demoStorms(sites: [string, number, number][][], weather: WeatherGrid[], day: number): RainBlob[] {
  const out: RainBlob[] = [];
  for (const regionSites of sites) {
    const site = regionSites[1] ?? regionSites[0];
    if (!site) continue;
    const [, lat, lng] = site;
    let { x, z } = project(lat, lng);
    for (let d = 1; d <= day; d++) {
      const w = weatherAt(weather, ...latLngOf(x, z))?.days[d - 1];
      const calm = !w || !Number.isFinite(w.windFrom);
      const dir = downwind(calm ? 270 : w.windFrom, 0);
      x += dir.dx * STORM_DRIFT_KM_DAY;
      z += dir.dz * STORM_DRIFT_KM_DAY;
    }
    out.push({ x, z, r: STORM_R_KM, intensity: Math.max(0.35, 1 - day * STORM_FADE_DAY) });
  }
  return out;
}

const latLngOf = (x: number, z: number): [number, number] => {
  const { lat, lng } = unproject(x, z);
  return [lat, lng];
};

// ------------------------------------------------------------ field for the animation
/** Smooth rain intensity field (0..1): weather grid (bilinear) plus demo storms. */
export class RainField {
  private grids: { lat0: number; lng0: number; step: number; nLat: number; nLng: number; v: Float32Array }[];
  readonly any: boolean;

  constructor(weather: WeatherGrid[], day: number, private blobs: RainBlob[] = []) {
    this.grids = weather.map((g) => {
      const v = new Float32Array(g.cells.length);
      // Today: live rain where it's raining now, else the rest of today's forecast total.
      g.cells.forEach((c, i) => { v[i] = day === 0 ? Math.max(nowIntensity(c.now.rain), dayIntensity(c.days[0]?.rainMm) * 0.6) : dayIntensity(c.days[day]?.rainMm); });
      return { lat0: g.lat0, lng0: g.lng0, step: g.step, nLat: g.nLat, nLng: g.nLng, v };
    });
    this.any = blobs.length > 0 || this.grids.some((g) => g.v.some((x) => x > 0));
  }

  at(x: number, z: number): number {
    let best = blobRain(this.blobs, x, z);
    const { lat, lng } = unproject(x, z);
    for (const g of this.grids) {
      // Small tolerance: projection round-trips land points on the grid edge a hair outside it.
      const E = 1e-6;
      let fi = (lng - g.lng0) / g.step, fj = (lat - g.lat0) / g.step;
      if (fi < -E || fj < -E || fi > g.nLng - 1 + E || fj > g.nLat - 1 + E) continue;
      fi = Math.min(Math.max(fi, 0), g.nLng - 1);
      fj = Math.min(Math.max(fj, 0), g.nLat - 1);
      const i = Math.min(Math.floor(fi), Math.max(0, g.nLng - 2)), j = Math.min(Math.floor(fj), Math.max(0, g.nLat - 2));
      const tx = fi - i, tz = fj - j, i1 = Math.min(i + 1, g.nLng - 1), j1 = Math.min(j + 1, g.nLat - 1);
      const a = g.v;
      const v = (a[j * g.nLng + i] * (1 - tx) + a[j * g.nLng + i1] * tx) * (1 - tz) + (a[j1 * g.nLng + i] * (1 - tx) + a[j1 * g.nLng + i1] * tx) * tz;
      best = Math.max(best, v);
      break;
    }
    return best;
  }
}
