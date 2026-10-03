/**
 * Fosberg Fire Weather Index (Fosberg 1978): instantaneous fire weather from
 * temperature, relative humidity and wind, 0–100. Same index as the team's
 * sensor station, so the map and the sensor speak one language.
 *
 * Fosberg has no memory of past rain, so we add a dryness factor (our own,
 * not part of Fosberg): fuels count as damp the day it rains and fully cured
 * after FULLY_DRY_DAYS without rain.
 */

/** A day with at least this much rain (mm) resets the dry-day count. */
export const WETTING_RAIN_MM = 2;
/** Dry days after which the dryness factor reaches 1. */
export const FULLY_DRY_DAYS = 14;
/** Dryness factor on a wetting-rain day. */
const WET_DAY_FACTOR = 0.6;

/** Equilibrium moisture content (%), T in °F, RH in %. */
function emc(tF: number, rh: number): number {
  if (rh < 10) return 0.03229 + 0.281073 * rh - 0.000578 * rh * tF;
  if (rh < 50) return 2.22749 + 0.160107 * rh - 0.01478 * tF;
  return 21.0606 + 0.005565 * rh * rh - 0.00035 * rh * tF - 0.483199 * rh;
}

/** Fosberg FFWI (0..100) from °C, % RH and km/h. */
export function fosbergFFWI(tempC: number, rh: number, windKmh: number): number {
  // Missing data (null/NaN from the API) → no signal, not bone-dry air.
  if (!Number.isFinite(tempC) || !Number.isFinite(rh) || !Number.isFinite(windKmh)) return 0;
  const tF = (tempC * 9) / 5 + 32;
  const mph = windKmh / 1.609344;
  const m = Math.max(0, emc(tF, Math.min(100, Math.max(0, rh)))) / 30;
  const eta = Math.max(0, 1 - 2 * m + 1.5 * m * m - 0.5 * m * m * m);
  return Math.min(100, (eta * Math.sqrt(1 + mph * mph)) / 0.3002);
}

/**
 * Days from `dayIdx` back to the last day with ≥ WETTING_RAIN_MM (0 = rained that day).
 * Returns `dayIdx + 1` when no wetting rain is in the history.
 */
export function daysSinceRain(precip: (number | null)[], dayIdx: number): number {
  for (let i = dayIdx; i >= 0; i--) if ((precip[i] ?? 0) >= WETTING_RAIN_MM) return dayIdx - i;
  return dayIdx + 1;
}

/** 0.6 on a rain day → 1.0 after FULLY_DRY_DAYS dry days. */
export function dryness(daysDry: number): number {
  return WET_DAY_FACTOR + (1 - WET_DAY_FACTOR) * Math.min(1, daysDry / FULLY_DRY_DAYS);
}

/** Weather risk 0..1 for the map (multiplied by fuel per hex later). */
export function fireWeatherRisk(ffwi: number, daysDry: number): number {
  return Math.min(1, (ffwi / 100) * dryness(daysDry));
}
