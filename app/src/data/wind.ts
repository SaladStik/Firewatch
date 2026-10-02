/** Smooth wind field for the animated streamlines: bilinear between the weather grid points. */
import { unproject } from "../geo/projection";
import { downwind } from "../world/spread";
import type { WeatherGrid } from "./openMeteo";

interface FieldGrid {
  lat0: number;
  lng0: number;
  step: number;
  nLat: number;
  nLng: number;
  /** Velocity the wind blows toward, world XZ in km/h (+X east, +Z south); missing data = calm. */
  vx: Float32Array;
  vz: Float32Array;
}

export class WindField {
  private grids: FieldGrid[];

  constructor(grids: WeatherGrid[], day: number) {
    this.grids = grids.map((g) => {
      const vx = new Float32Array(g.cells.length), vz = new Float32Array(g.cells.length);
      g.cells.forEach((c, i) => {
        const w = c.days[day];
        if (!w || !Number.isFinite(w.wind) || !Number.isFinite(w.windFrom)) return;
        const d = downwind(w.windFrom, w.wind);
        vx[i] = d.dx * w.wind;
        vz[i] = d.dz * w.wind;
      });
      return { lat0: g.lat0, lng0: g.lng0, step: g.step, nLat: g.nLat, nLng: g.nLng, vx, vz };
    });
  }

  /** Wind at a world point, or null outside every grid. */
  at(x: number, z: number): { vx: number; vz: number; kmh: number } | null {
    const { lat, lng } = unproject(x, z);
    for (const g of this.grids) {
      // Small tolerance: projection round-trips land points on the grid edge a hair outside it.
      const E = 1e-6;
      let fi = (lng - g.lng0) / g.step, fj = (lat - g.lat0) / g.step;
      if (fi < -E || fj < -E || fi > g.nLng - 1 + E || fj > g.nLat - 1 + E) continue;
      fi = Math.min(Math.max(fi, 0), g.nLng - 1);
      fj = Math.min(Math.max(fj, 0), g.nLat - 1);
      const i = Math.min(Math.floor(fi), Math.max(0, g.nLng - 2)), j = Math.min(Math.floor(fj), Math.max(0, g.nLat - 2));
      const tx = fi - i, tz = fj - j;
      const i1 = Math.min(i + 1, g.nLng - 1), j1 = Math.min(j + 1, g.nLat - 1);
      const mix = (a: Float32Array) =>
        (a[j * g.nLng + i] * (1 - tx) + a[j * g.nLng + i1] * tx) * (1 - tz) + (a[j1 * g.nLng + i] * (1 - tx) + a[j1 * g.nLng + i1] * tx) * tz;
      const vx = mix(g.vx), vz = mix(g.vz);
      return { vx, vz, kmh: Math.sqrt(vx * vx + vz * vz) };
    }
    return null;
  }
}
