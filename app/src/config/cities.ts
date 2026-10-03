/**
 * Cities with a street-level raster (scripts/bake-city.ts → public/data/<region>/cities/<id>.png).
 * At street zoom (the two finest levels) the map samples land cover and elevation from these
 * instead of the province's coarse raster, so 40 m hexes follow real parks, rivers and blocks.
 */
export interface CityRaster {
  id: string;
  name: string;
  /** REGIONS id the city belongs to. */
  region: string;
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number];
  /** Raster resolution (km per pixel). */
  pxKm: number;
  /** Terrarium elevation zoom (13 ≈ 12 m per pixel at 51° N). */
  demZoom: number;
}

export const CITIES: CityRaster[] = [
  { id: "calgary", name: "Calgary", region: "alberta", bbox: [-114.33, 50.84, -113.85, 51.22], pxKm: 0.02, demZoom: 13 },
  { id: "edmonton", name: "Edmonton", region: "alberta", bbox: [-113.72, 53.39, -113.27, 53.72], pxKm: 0.02, demZoom: 13 },
];

/** Levels at or above this index are "street zoom": city rasters, every local street, white buildings. */
export const STREET_LEVEL = 5;
