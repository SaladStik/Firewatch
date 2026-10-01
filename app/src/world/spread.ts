/**
 * Wind-driven spread potential around a hotspot. Instead of a plain circle,
 * the danger zone is pushed downwind:
 *   reach(θ) = SPREAD_BASE_KM · (1 + stretch · cos θ),  θ = angle from downwind
 *   influence = 1 − distance / reach   (0 outside)
 * Calm air → 30 km circle. Strong wind → ~51 km downwind, ~9 km upwind.
 */

/** Reach in calm air (km). */
export const SPREAD_BASE_KM = 30;
/** Largest downwind stretch (fraction of the base reach). */
export const MAX_STRETCH = 0.7;
/** Wind speed (km/h) at which the stretch is at its maximum. */
const FULL_STRETCH_KMH = 40;
/** Furthest any hotspot can reach (km); use as the search radius. */
export const SPREAD_MAX_KM = SPREAD_BASE_KM * (1 + MAX_STRETCH);

/** Unit vector the wind pushes fire along (world XZ, +X east, +Z south) and how strongly. */
export interface Downwind {
  dx: number;
  dz: number;
  stretch: number;
}

/** `fromDeg` is meteorological: the direction the wind blows FROM, 0 = north, 90 = east. */
export function downwind(fromDeg: number, kmh: number): Downwind {
  const a = (fromDeg * Math.PI) / 180;
  return { dx: -Math.sin(a), dz: Math.cos(a), stretch: MAX_STRETCH * Math.min(1, kmh / FULL_STRETCH_KMH) };
}

/** Influence 0..1 of a hotspot on a point offset (vx, vz) km from it. */
export function spreadInfluence(vx: number, vz: number, w: Downwind): number {
  const d = Math.hypot(vx, vz);
  if (d === 0) return 1;
  const cos = (vx * w.dx + vz * w.dz) / d;
  return Math.max(0, 1 - d / (SPREAD_BASE_KM * (1 + w.stretch * cos)));
}
