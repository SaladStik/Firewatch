/**
 * Demo scenario: what the highways do while the scenario's fires are burning.
 *
 * The weather side of the scenario multiplies fire danger and drifts a rainstorm across the
 * map (data/hazards.ts, data/rain.ts). This is the same idea for the roads, and it completes
 * the chain the scenario already starts: simulated ignitions threaten towns, and the people
 * in those towns leave on the highways — the same highways the fire is closing.
 *
 * Three effects, all of them scenario-only and all clearly flagged in the UI. None of them
 * touch fire behaviour: traffic changes what a fire *costs*, not how it burns, so the hazard
 * snapshot and the map are untouched.
 *
 *   1. Demand. A long-weekend multiplier on every corridor (SIM_TRAFFIC_BOOST).
 *   2. Evacuation. A town above EVAC_AT puts its people on the road, as extra vehicles a day
 *      centred on the town and fading out over EVAC_R_KM.
 *   3. Closure. A stretch within SIM_CLOSURE_KM of a fire, or inside the projected spread, is
 *      shut — so the busiest road near the fire is also the one that can't be used.
 *
 * Every number here is an assumption about the scenario, not a measurement. The real traffic
 * counts and the prediction built on them are in data/traffic.ts.
 */
import { project } from "../geo/projection";
import type { CommunityThreat } from "./communityRisk";

/** Long-weekend demand on every corridor (1 = the measured counts). Mirrors SIM_WEATHER_BOOST. */
export const SIM_TRAFFIC_BOOST = 1.25;

/**
 * A town at this threat or above, with a fire actually coming at it, is treated as having
 * been told to go. Fire weather alone never empties a town: it is listed because it is
 * exposed where it stands, not because anything is on its way (data/communityRisk.ts).
 */
export const EVAC_AT = 0.5;
/** Share of a threatened town that leaves, and how many of them share a vehicle. */
const EVAC_SHARE = 0.8;
const PEOPLE_PER_VEHICLE = 2.6;
/**
 * Days the outflow is spread over. An evacuation order empties a town in about a day: Fort
 * McMurray's 88,000 people were out within one in May 2016, which is what put ~30,000 extra
 * vehicles on Highway 63.
 */
const EVAC_DAYS = 1;
/** How far from the town the extra traffic is still felt (km). */
const EVAC_R_KM = 60;
/** A stretch of road within this distance of a fire is closed in the scenario (km). */
export const SIM_CLOSURE_KM = 3;

/** Extra vehicles a day centred on a town, fading to nothing at `r`. */
export interface TrafficSurge {
  x: number;
  z: number;
  r: number;
  /** Extra vehicles per day at the centre. */
  vehPerDay: number;
  /** The town they're leaving, for the UI. */
  place: string;
}

/**
 * Evacuation outflow for the towns on the "communities at risk" list, which is already
 * re-scored for the selected day — so as the scenario's spread grows and reaches more towns,
 * more of them appear here.
 */
export function evacSurges(threats: CommunityThreat[]): TrafficSurge[] {
  const out: TrafficSurge[] = [];
  for (const t of threats) {
    if (t.kind === "weather" || t.score < EVAC_AT || !(t.place.pop > 0)) continue;
    // Scaled by the threat: a town that is merely near a fire doesn't empty like one in its path.
    const vehPerDay = ((t.place.pop * EVAC_SHARE) / PEOPLE_PER_VEHICLE / EVAC_DAYS) * t.score;
    out.push({ ...project(t.place.lat, t.place.lng), r: EVAC_R_KM, vehPerDay, place: t.place.name });
  }
  return out;
}

/**
 * Extra vehicles a day at a point. Surges add up, unlike rain blobs which take the strongest:
 * two towns leaving past the same junction put both their cars on it.
 */
export function surgeTraffic(surges: TrafficSurge[], x: number, z: number): number {
  let sum = 0;
  for (const s of surges) {
    const d = Math.hypot(x - s.x, z - s.z) / s.r;
    if (d < 1) sum += s.vehPerDay * (1 - d * d) ** 2;
  }
  return sum;
}

/** The whole scenario as `corridorThreats` takes it. */
export interface TrafficScenario {
  boost: number;
  surges: TrafficSurge[];
}

/** The scenario for a day, from that day's community threat list. */
export function trafficScenario(threats: CommunityThreat[]): TrafficScenario {
  return { boost: SIM_TRAFFIC_BOOST, surges: evacSurges(threats) };
}
