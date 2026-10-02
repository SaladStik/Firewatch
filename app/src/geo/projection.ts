/**
 * World projection shared by the app, the worker and the bake scripts.
 *
 * Lambert conformal conic (spherical) — the projection Statistics Canada uses for
 * national maps — so every province from BC to Newfoundland keeps its shape.
 * World units are kilometres on the XZ plane: +X = east, -Z = north, +Y = up.
 *
 * Call setProjection() once (main thread AND worker). It must match the parameters
 * the regions were baked with (see PROJECTION in config/regions.ts).
 */

export interface ProjectionParams {
  /** Latitude of origin (map centre, degrees). */
  lat0: number;
  /** Central meridian (degrees). */
  lng0: number;
  /** Standard parallels (degrees). */
  lat1: number;
  lat2: number;
}

const R_EARTH = 6371.0088; // km
const DEG = Math.PI / 180;

let n = 1, F = 1, rho0 = 1, lng0 = 0;

export function setProjection(p: ProjectionParams) {
  const p1 = p.lat1 * DEG, p2 = p.lat2 * DEG, p0 = p.lat0 * DEG;
  const t = (phi: number) => Math.tan(Math.PI / 4 + phi / 2);
  n = p1 === p2 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  F = (Math.cos(p1) * Math.pow(t(p1), n)) / n;
  rho0 = (R_EARTH * F) / Math.pow(t(p0), n);
  lng0 = p.lng0;
}

export interface WorldXZ {
  x: number;
  z: number;
}

export function project(lat: number, lng: number): WorldXZ {
  const rho = (R_EARTH * F) / Math.pow(Math.tan(Math.PI / 4 + (lat * DEG) / 2), n);
  const theta = n * (lng - lng0) * DEG;
  return { x: rho * Math.sin(theta), z: -(rho0 - rho * Math.cos(theta)) };
}

export function unproject(x: number, z: number): { lat: number; lng: number } {
  const y = -z;
  const rho = Math.sign(n) * Math.hypot(x, rho0 - y);
  const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * (rho0 - y));
  const lat = 2 * Math.atan(Math.pow((R_EARTH * F) / rho, 1 / n)) - Math.PI / 2;
  return { lat: lat / DEG, lng: lng0 + theta / n / DEG };
}
