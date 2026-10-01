/**
 * World projection shared by the app, the worker and the bake scripts.
 *
 * Sinusoidal (equal-area) projection centred on the active region. World
 * units are kilometres on the XZ plane: +X = east, -Z = north, +Y = up.
 * Call setProjectionCenter() once per region (main thread AND worker) —
 * it must match the centre used when that region was baked.
 */

let LAT0 = 54.5;
let LNG0 = -115;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_EQ = 111.32;
const DEG = Math.PI / 180;

export function setProjectionCenter(lat0: number, lng0: number) {
  LAT0 = lat0;
  LNG0 = lng0;
}

export interface WorldXZ {
  x: number;
  z: number;
}

export function project(lat: number, lng: number): WorldXZ {
  return {
    x: (lng - LNG0) * KM_PER_DEG_LNG_EQ * Math.cos(lat * DEG),
    z: (LAT0 - lat) * KM_PER_DEG_LAT,
  };
}

export function unproject(x: number, z: number): { lat: number; lng: number } {
  const lat = LAT0 - z / KM_PER_DEG_LAT;
  return { lat, lng: LNG0 + x / (KM_PER_DEG_LNG_EQ * Math.cos(lat * DEG)) };
}
