/**
 * ─── REGIONS ──────────────────────────────────────────────────────────────
 * Everything province-specific lives here. All regions in the WORKSPACE are
 * loaded side by side on one map; the ones in focus render at full strength,
 * the rest slightly greyed (click one, or use the Regions menu, to focus it).
 *
 * To add a province:
 *   1. add an entry to REGIONS (boundaryName must match the provinces GeoJSON,
 *      iso = its ISO 3166-2 code, used to find it in OpenStreetMap)
 *   2. `npm run bake -- <id>` and `npm run bake:osm -- <id>`
 *   3. add its id to WORKSPACE.regions (the order there is the load order)
 */
import { ALBERTA_PLACES, type Place } from "../data/places";
import type { ProjectionParams } from "../geo/projection";
import type { Landmark } from "../hex/overlayStyles";

/**
 * One projection for the whole country: Lambert conformal conic with the same
 * parameters as Statistics Canada's national maps (EPSG:3347-style). Every region
 * is baked with it so they line up — changing it means re-baking every terrain raster.
 */
export const PROJECTION: ProjectionParams = { lat0: 63.390675, lng0: -91.866667, lat1: 49, lat2: 77 };

export interface Region {
  id: string;
  name: string;
  /** Two-letter code for compact UI. */
  code: string;
  /** ISO 3166-2 code — how the bake script finds the province in OpenStreetMap. */
  iso: string;
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
    iso: "CA-AB",
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
    iso: "CA-BC",
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
    iso: "CA-SK",
    boundaryName: "Saskatchewan",
    bbox: [-110.1, 48.9, -101.3, 60.1],
    pxKm: 0.5,
    places: [],
    demoSites: [["La Ronge N", 55.3, -105.2]],
    landmarks: [],
  },
  manitoba: {
    id: "manitoba",
    name: "Manitoba",
    code: "MB",
    iso: "CA-MB",
    boundaryName: "Manitoba",
    bbox: [-102.1, 48.9, -88.9, 60.1],
    pxKm: 0.7,
    places: [],
    demoSites: [["Thompson S", 55.2, -97.9]],
    landmarks: [],
  },
  ontario: {
    id: "ontario",
    name: "Ontario",
    code: "ON",
    iso: "CA-ON",
    boundaryName: "Ontario",
    bbox: [-95.2, 41.6, -74.3, 56.9],
    pxKm: 0.8,
    places: [],
    demoSites: [["Red Lake", 51.0, -93.8], ["Timmins N", 49.2, -81.4]],
    landmarks: [
      { name: "CN Tower", lat: 43.6426, lng: -79.3871, kind: "needle", heightM: 553, sizeKm: 0.1 },
    ],
  },
  quebec: {
    id: "quebec",
    name: "Quebec",
    code: "QC",
    iso: "CA-QC",
    boundaryName: "Quebec",
    bbox: [-79.8, 44.9, -57.1, 62.6],
    pxKm: 1.0,
    places: [],
    demoSites: [["Chibougamau N", 50.2, -74.3]],
    landmarks: [],
  },
  "new-brunswick": {
    id: "new-brunswick",
    name: "New Brunswick",
    code: "NB",
    iso: "CA-NB",
    boundaryName: "New Brunswick",
    bbox: [-69.1, 44.5, -63.7, 48.1],
    pxKm: 0.4,
    places: [],
    demoSites: [["Miramichi", 46.9, -65.6]],
    landmarks: [],
  },
  "nova-scotia": {
    id: "nova-scotia",
    name: "Nova Scotia",
    code: "NS",
    iso: "CA-NS",
    boundaryName: "Nova Scotia",
    bbox: [-66.4, 43.3, -59.6, 47.1],
    pxKm: 0.4,
    places: [],
    demoSites: [["Kejimkujik", 44.4, -65.2]],
    landmarks: [],
  },
  "prince-edward-island": {
    id: "prince-edward-island",
    name: "Prince Edward Island",
    code: "PE",
    iso: "CA-PE",
    boundaryName: "Prince Edward Island",
    bbox: [-64.5, 45.9, -61.9, 47.1],
    pxKm: 0.3,
    places: [],
    demoSites: [],
    landmarks: [],
  },
  "newfoundland-and-labrador": {
    id: "newfoundland-and-labrador",
    name: "Newfoundland and Labrador",
    code: "NL",
    iso: "CA-NL",
    boundaryName: "Newfoundland and Labrador",
    bbox: [-67.9, 46.6, -52.6, 60.4],
    pxKm: 0.8,
    places: [],
    demoSites: [["Labrador City", 52.9, -66.9]],
    landmarks: [],
  },
  yukon: {
    id: "yukon",
    name: "Yukon",
    code: "YT",
    iso: "CA-YT",
    boundaryName: "Yukon Territory",
    bbox: [-141.1, 59.9, -123.8, 69.7],
    pxKm: 0.8,
    places: [],
    demoSites: [["Whitehorse N", 61.0, -135.0]],
    landmarks: [],
  },
  "northwest-territories": {
    id: "northwest-territories",
    name: "Northwest Territories",
    code: "NT",
    iso: "CA-NT",
    boundaryName: "Northwest Territories",
    bbox: [-136.5, 59.9, -101.9, 78.8],
    pxKm: 1.2,
    places: [],
    demoSites: [["Fort Smith", 60.0, -111.9]],
    landmarks: [],
  },
  nunavut: {
    id: "nunavut",
    name: "Nunavut",
    code: "NU",
    iso: "CA-NU",
    boundaryName: "Nunavut",
    bbox: [-121.1, 51.6, -61.0, 83.2],
    pxKm: 1.6,
    places: [],
    demoSites: [],
    landmarks: [],
  },
};

/**
 * Regions loaded together, in LOAD ORDER (focused regions always load first), and
 * which are in focus when the app opens (override with ?focus=ab,bc).
 */
export const WORKSPACE = {
  regions: [
    "alberta", "british-columbia", "saskatchewan", "manitoba", "ontario", "quebec",
    "new-brunswick", "nova-scotia", "prince-edward-island", "newfoundland-and-labrador",
    "yukon", "northwest-territories", "nunavut",
  ],
  defaultFocus: ["alberta"],
};

export function initialFocus(): string[] {
  const q = new URLSearchParams(location.search).get("focus");
  if (!q) return WORKSPACE.defaultFocus;
  const ids = q.split(",").map((c) => Object.values(REGIONS).find((r) => r.code.toLowerCase() === c.trim().toLowerCase() || r.id === c.trim())?.id);
  const valid = ids.filter((id): id is string => !!id && WORKSPACE.regions.includes(id));
  return valid.length ? valid : WORKSPACE.defaultFocus;
}
