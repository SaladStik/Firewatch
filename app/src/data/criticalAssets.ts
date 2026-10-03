/**
 * Critical infrastructure for values-at-risk / evac checklists on fire duty.
 * Approximate public locations for demo planning — not an official inventory.
 */
export type AssetKind = "school" | "hospital" | "industrial" | "power";

export interface CriticalAsset {
  id: string;
  name: string;
  kind: AssetKind;
  lat: number;
  lng: number;
  /** REGIONS id (e.g. "alberta"). */
  regionId: string;
  /** Short duty note (capacity, product, corridor). */
  note?: string;
}

export const ASSET_LABEL: Record<AssetKind, string> = {
  school: "School",
  hospital: "Hospital",
  industrial: "Industrial",
  power: "Power",
};

/** Kind order on the checklist (life-safety first). */
export const ASSET_KIND_ORDER: AssetKind[] = ["hospital", "school", "industrial", "power"];

/**
 * Seed set focused on Alberta demo fire country + major centres.
 * Coords are approximate; good enough for proximity banding on the hex map.
 */
export const CRITICAL_ASSETS: CriticalAsset[] = [
  // ── Fort McMurray / Wood Buffalo ──────────────────────────────────────────
  { id: "ab-nlrh", name: "Northern Lights Regional Health Centre", kind: "hospital", lat: 56.7265, lng: -111.3803, regionId: "alberta", note: "Regional hospital · Fort McMurray" },
  { id: "ab-fm-composite", name: "Fort McMurray Composite High", kind: "school", lat: 56.7269, lng: -111.3705, regionId: "alberta" },
  { id: "ab-father-mercredi", name: "Father Mercredi High School", kind: "school", lat: 56.7322, lng: -111.392, regionId: "alberta" },
  { id: "ab-westwood", name: "Westwood Community High", kind: "school", lat: 56.718, lng: -111.412, regionId: "alberta" },
  { id: "ab-suncor-base", name: "Suncor Base Plant", kind: "industrial", lat: 57.005, lng: -111.48, regionId: "alberta", note: "Oilsands · process units" },
  { id: "ab-syncrude", name: "Syncrude Mildred Lake", kind: "industrial", lat: 57.04, lng: -111.55, regionId: "alberta", note: "Oilsands · upgrader" },
  { id: "ab-cnrl-horizon", name: "CNRL Horizon", kind: "industrial", lat: 57.35, lng: -111.75, regionId: "alberta", note: "Oilsands" },
  { id: "ab-fm-230kv", name: "Fort McMurray 240 kV corridor", kind: "power", lat: 56.78, lng: -111.45, regionId: "alberta", note: "AESO north feed" },

  // ── Slave Lake / Swan Hills ───────────────────────────────────────────────
  { id: "ab-sl-health", name: "Slave Lake Healthcare Centre", kind: "hospital", lat: 55.2835, lng: -114.771, regionId: "alberta" },
  { id: "ab-sl-school", name: "Roland Michener Secondary", kind: "school", lat: 55.281, lng: -114.765, regionId: "alberta" },
  { id: "ab-swan-hills-tx", name: "Swan Hills Treatment Centre", kind: "industrial", lat: 54.72, lng: -115.4, regionId: "alberta", note: "Hazardous waste · demo site" },
  { id: "ab-sl-power", name: "Slave Lake substation", kind: "power", lat: 55.29, lng: -114.76, regionId: "alberta", note: "ATCO distribution" },

  // ── Grande Prairie / Peace ────────────────────────────────────────────────
  { id: "ab-gp-hospital", name: "Grande Prairie Regional Hospital", kind: "hospital", lat: 55.178, lng: -118.795, regionId: "alberta" },
  { id: "ab-gp-composite", name: "Grande Prairie Composite High", kind: "school", lat: 55.171, lng: -118.80, regionId: "alberta" },
  { id: "ab-weyerhaeuser-gp", name: "International Paper (GP)", kind: "industrial", lat: 55.14, lng: -118.85, regionId: "alberta", note: "Pulp / lumber" },
  { id: "ab-chinchaga-line", name: "Chinchaga 144 kV spur", kind: "power", lat: 57.55, lng: -118.85, regionId: "alberta", note: "Near demo fire country" },

  // ── Edmonton / capital region ─────────────────────────────────────────────
  { id: "ab-uah", name: "University of Alberta Hospital", kind: "hospital", lat: 53.5205, lng: -113.524, regionId: "alberta" },
  { id: "ab-royal-alex", name: "Royal Alexandra Hospital", kind: "hospital", lat: 53.558, lng: -113.505, regionId: "alberta" },
  { id: "ab-ross-sheppard", name: "Ross Sheppard High School", kind: "school", lat: 53.565, lng: -113.545, regionId: "alberta" },
  { id: "ab-refinery-row", name: "Refinery Row (Strathcona)", kind: "industrial", lat: 53.55, lng: -113.37, regionId: "alberta", note: "Petrochemical cluster" },
  { id: "ab-ellis", name: "Ellerslie 500 kV terminal", kind: "power", lat: 53.4, lng: -113.45, regionId: "alberta", note: "AESO Edmonton south" },

  // ── Calgary / south ───────────────────────────────────────────────────────
  { id: "ab-fmc", name: "Foothills Medical Centre", kind: "hospital", lat: 51.065, lng: -114.133, regionId: "alberta" },
  { id: "ab-plc", name: "Alberta Children's Hospital", kind: "hospital", lat: 51.062, lng: -114.148, regionId: "alberta" },
  { id: "ab-western-canada", name: "Western Canada High School", kind: "school", lat: 51.037, lng: -114.08, regionId: "alberta" },
  { id: "ab-imperial-calgary", name: "Imperial Strathcona / Calgary area fuels", kind: "industrial", lat: 51.02, lng: -113.98, regionId: "alberta", note: "Fuels / logistics" },
  { id: "ab-langdon", name: "Langdon HVDC / 500 kV", kind: "power", lat: 50.997, lng: -113.68, regionId: "alberta", note: "Southern Alberta backbone" },

  // ── Rocky Mountain House / west-central ───────────────────────────────────
  { id: "ab-rmh-health", name: "Rocky Mountain House Health Centre", kind: "hospital", lat: 52.377, lng: -114.92, regionId: "alberta" },
  { id: "ab-rmh-school", name: "West Central High School", kind: "school", lat: 52.375, lng: -114.915, regionId: "alberta" },
  { id: "ab-clearwater-gas", name: "Clearwater gas plant corridor", kind: "industrial", lat: 52.35, lng: -115.55, regionId: "alberta", note: "Near Rocky Mtn House W demo" },
  { id: "ab-rmh-power", name: "Rocky 138 kV tap", kind: "power", lat: 52.38, lng: -114.95, regionId: "alberta" },

  // ── Hinton / Edson / Jasper gateway ───────────────────────────────────────
  { id: "ab-hinton-health", name: "Hinton Healthcare Centre", kind: "hospital", lat: 53.404, lng: -117.57, regionId: "alberta" },
  { id: "ab-west-fraser", name: "West Fraser Hinton pulp", kind: "industrial", lat: 53.41, lng: -117.6, regionId: "alberta" },
  { id: "ab-ycar-line", name: "YC / Yellowhead transmission", kind: "power", lat: 53.5, lng: -116.8, regionId: "alberta", note: "Edson–Hinton corridor" },
];

export function assetsForRegions(regionIds: Iterable<string>): CriticalAsset[] {
  const want = new Set(regionIds);
  return CRITICAL_ASSETS.filter((a) => want.has(a.regionId));
}
