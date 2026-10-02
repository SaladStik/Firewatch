/** Wind per weather cell for the map's animated arrows (one entry per grid point with valid wind). */
import { project } from "../geo/projection";
import { downwind } from "../world/spread";
import type { WeatherGrid } from "./openMeteo";

export interface WindVector {
  /** World position of the weather cell (km). */
  x: number;
  z: number;
  /** Unit vector the wind blows toward (world XZ, +X east, +Z south). */
  dx: number;
  dz: number;
  kmh: number;
}

export function windVectors(grids: WeatherGrid[], day: number): WindVector[] {
  return grids.flatMap((g) => g.cells.flatMap((c) => {
    const w = c.days[day];
    if (!w || !Number.isFinite(w.wind) || !Number.isFinite(w.windFrom)) return [];
    const { dx, dz } = downwind(w.windFrom, w.wind);
    return [{ ...project(c.lat, c.lng), dx, dz, kmh: w.wind }];
  }));
}
