/**
 * ─── REGIONS ──────────────────────────────────────────────────────────────
 * Everything province-specific lives here. All regions in the WORKSPACE are
 * loaded side by side on one map; the ones in focus render at full strength,
 * the rest slightly greyed (click one, or use the Regions menu, to focus it).
 *
 * To add a province:
 *   1. add an entry to REGIONS (boundaryName must match the provinces GeoJSON)
 *   2. `npm run bake -- <id>` and `npm run bake:osm -- <id>`
 *   3. add its id to WORKSPACE.regions
 */
import { ALBERTA_PLACES, type Place } from "../data/places";
import type { Landmark } from "../hex/overlayStyles";

/**
 * One projection for the whole workspace (sinusoidal, km). Every region is baked
 * with this centre so they line up — changing it means re-baking every region.
 */
export const PROJECTION = { lat0: 54.5, lng0: -115 };

export interface Region {
  id: string;
  name: string;
  /** Two-letter code for compact UI. */
  code: string;
  /** Feature name in the provinces GeoJSON used by the bake script. */
  boundaryName: string;
  /** [west, south, east, north] in degrees — data fetch + bake extent. */
  bbox: [number, number, number, number];
  /** Terrain raster resolution (km/pixel). Bigger provinces can use a coarser raster. */
  pxKm: number;
  /** Fallback labels if the OSM places bake hasn't been run. */
  places: Place[];
  /** Locations for the clearly-labelled demo scenario (name, lat, lng). */
  demoSites: [string, number, number][];
  /** Hand-modelled landmarks (replace the OSM building at the same spot). */
  landmarks: Landmark[];
}

export const REGIONS: Record<string, Region> = {
  alberta: {
    id: "alberta",
    name: "Alberta",
    code: "AB",
    boundaryName: "Alberta",
    bbox: [-120.1, 48.9, -109.9, 60.1],
    pxKm: 0.5,
    places: ALBERTA_PLACES,
    demoSites: [
      ["Swan Hills", 54.72, -115.4], ["Chinchaga", 57.6, -118.9], ["Fort McMurray S", 56.45, -111.35],
      ["Rocky Mtn House W", 52.35, -115.6], ["Slave Lake N", 55.6, -114.7], ["Wood Buffalo", 58.9, -113.2],
    ],
    landmarks: [
      { name: "Calgary Tower", lat: 51.04427, lng: -114.0631, kind: "needle", heightM: 191, sizeKm: 0.09 },
      { name: "Scotiabank Saddledome", lat: 51.0374, lng: -114.0519, kind: "saddle", heightM: 45, sizeKm: 0.2 },
      { name: "Alberta Legislature", lat: 53.5337, lng: -113.5064, kind: "dome", heightM: 57, sizeKm: 0.16 },
      { name: "Muttart Conservatory", lat: 53.5352, lng: -113.4766, kind: "pyramids", heightM: 26, sizeKm: 0.16 },
    ],
  },
  "british-columbia": {
    id: "british-columbia",
    name: "British Columbia",
    code: "BC",
    boundaryName: "British Columbia",
    bbox: [-139.1, 48.2, -114.0, 60.1],
    pxKm: 0.6,
    places: [],
    demoSites: [["Kamloops N", 51.0, -120.3], ["Prince George E", 53.9, -122.3]],
    landmarks: [],
  },
  saskatchewan: {
    id: "saskatchewan",
    name: "Saskatchewan",
    code: "SK",
    boundaryName: "Saskatchewan",
    bbox: [-110.1, 48.9, -101.3, 60.1],
    pxKm: 0.5,
    places: [],
    demoSites: [["La Ronge N", 55.3, -105.2]],
    landmarks: [],
  },
};

/** Regions loaded together, and which are in focus when the app opens (override with ?focus=ab,bc). */
export const WORKSPACE = {
  regions: ["alberta", "british-columbia", "saskatchewan"],
  defaultFocus: ["alberta"],
};

export function initialFocus(): string[] {
  const q = new URLSearchParams(location.search).get("focus");
  if (!q) return WORKSPACE.defaultFocus;
  const ids = q.split(",").map((c) => Object.values(REGIONS).find((r) => r.code.toLowerCase() === c.trim().toLowerCase() || r.id === c.trim())?.id);
  const valid = ids.filter((id): id is string => !!id && WORKSPACE.regions.includes(id));
  return valid.length ? valid : WORKSPACE.defaultFocus;
}
