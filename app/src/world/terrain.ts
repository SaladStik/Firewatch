/**
 * Terrain raster sampler (pure — used inside the worker).
 * Raster produced by scripts/bake-terrain.ts.
 */
import { LandClass } from "../geo/landClass";
import type { TerrainMeta } from "./types";

export class Terrain {
  readonly meta: TerrainMeta;
  /** Whole metres (0..65535) — half the memory of floats; there are 13 provinces' worth. */
  private elev: Uint16Array;
  private land: Uint8Array;
  /** World-space bounds of the raster (cheap rejection before sampling). */
  readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number;

  constructor(meta: TerrainMeta, rgba: Uint8ClampedArray) {
    this.meta = meta;
    this.x0 = meta.minX; this.x1 = meta.minX + meta.width * meta.pxKm;
    this.z0 = meta.minZ; this.z1 = meta.minZ + meta.height * meta.pxKm;
    const n = meta.width * meta.height;
    this.elev = new Uint16Array(n);
    this.land = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.elev[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1];
      this.land[i] = rgba[i * 4 + 2];
    }
  }

  /** Bilinear elevation (m) at world x,z. */
  elevation(x: number, z: number): number {
    const { width, height, pxKm, minX, minZ } = this.meta;
    const fx = Math.min(width - 1.001, Math.max(0, (x - minX) / pxKm - 0.5));
    const fz = Math.min(height - 1.001, Math.max(0, (z - minZ) / pxKm - 0.5));
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const e = this.elev, k = j * width + i;
    return (e[k] * (1 - tx) + e[k + 1] * tx) * (1 - tz) + (e[k + width] * (1 - tx) + e[k + width + 1] * tx) * tz;
  }

  /** Nearest land class at world x,z (None outside Alberta). */
  landAt(x: number, z: number): LandClass {
    const { width, height, pxKm, minX, minZ } = this.meta;
    const i = Math.floor((x - minX) / pxKm), j = Math.floor((z - minZ) / pxKm);
    if (i < 0 || j < 0 || i >= width || j >= height) return LandClass.None;
    return this.land[j * width + i] as LandClass;
  }

  /** Majority land class over the centre + 6 inner points of a hex. */
  landMajority(x: number, z: number, size: number): LandClass {
    const votes = new Uint8Array(16);
    const c = this.landAt(x, z);
    if (c === LandClass.None) return c;
    votes[c] += 2; // centre breaks ties
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      votes[this.landAt(x + Math.cos(a) * size * 0.55, z + Math.sin(a) * size * 0.55)]++;
    }
    votes[LandClass.None] = 0;
    // Settlements punch above their weight (they matter most for response).
    if (votes[LandClass.Urban] >= 2) return LandClass.Urban;
    let best: LandClass = c;
    for (let k = 1; k < 16; k++) if (votes[k] > votes[best]) best = k as LandClass;
    return best;
  }
}

/**
 * Every workspace region's raster, side by side in one projection. A point belongs
 * to the first region whose raster says it's land (provinces don't overlap).
 * City rasters (20 m, scripts/bake-city.ts) sit in front of their province at street zoom
 * (`street` = true): land cover and elevation come from them wherever they cover.
 */
export class TerrainStack {
  private layers: { index: number; t: Terrain }[] = [];
  private cities: { index: number; t: Terrain }[] = [];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  add(index: number, t: Terrain) {
    this.layers.push({ index, t });
    const m = t.meta;
    const b = { minX: m.minX, maxX: m.minX + m.width * m.pxKm, minZ: m.minZ, maxZ: m.minZ + m.height * m.pxKm };
    this.bounds = this.bounds
      ? { minX: Math.min(this.bounds.minX, b.minX), maxX: Math.max(this.bounds.maxX, b.maxX), minZ: Math.min(this.bounds.minZ, b.minZ), maxZ: Math.max(this.bounds.maxZ, b.maxZ) }
      : b;
  }
  /** A city's street-level raster, belonging to region `index`. */
  addCity(index: number, t: Terrain) {
    this.cities.push({ index, t });
  }
  private layerAt(x: number, z: number, street = false) {
    if (street) for (const l of this.cities) {
      const t = l.t;
      if (x < t.x0 || x >= t.x1 || z < t.z0 || z >= t.z1) continue;
      if (t.landAt(x, z) !== LandClass.None) return l;
    }
    for (const l of this.layers) {
      const t = l.t;
      if (x < t.x0 || x >= t.x1 || z < t.z0 || z >= t.z1) continue;
      if (t.landAt(x, z) !== LandClass.None) return l;
    }
    return null;
  }
  /** Workspace index of the region at (x,z), or -1. */
  regionAt(x: number, z: number, street = false): number {
    return this.layerAt(x, z, street)?.index ?? -1;
  }
  landAt(x: number, z: number, street = false): LandClass {
    return this.layerAt(x, z, street)?.t.landAt(x, z) ?? LandClass.None;
  }
  landMajority(x: number, z: number, size: number, street = false): LandClass {
    return this.layerAt(x, z, street)?.t.landMajority(x, z, size) ?? LandClass.None;
  }
  elevation(x: number, z: number, street = false): number {
    const l = this.layerAt(x, z, street) ?? this.layers[0];
    return l ? l.t.elevation(x, z) : 0;
  }
}
