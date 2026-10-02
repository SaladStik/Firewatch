/** Small display helpers for weather values and compass sectors. */
export const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

export const COMPASS_NAMES: Record<CompassPoint, string> = {
  N: "North",
  NE: "Northeast",
  E: "East",
  SE: "Southeast",
  S: "South",
  SW: "Southwest",
  W: "West",
  NW: "Northwest",
};

/** Degrees → 8-point compass abbreviation. */
export function compass(deg: number): CompassPoint {
  return COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export function compassName(deg: number): string {
  return COMPASS_NAMES[compass(deg)];
}

/** Compass octant of a point relative to a bbox centre [west, south, east, north]. */
export function sectorOf(lat: number, lng: number, bbox: [number, number, number, number]): CompassPoint {
  const cy = (bbox[1] + bbox[3]) / 2;
  const cx = (bbox[0] + bbox[2]) / 2;
  const deg = (90 - Math.atan2(lat - cy, lng - cx) * (180 / Math.PI) + 360) % 360;
  return compass(deg);
}

/** Forecast day index → "Today" / "Thu 1" (local date) / "+3d" when dates aren't loaded. */
export function dayLabel(day: number, dates?: string[]): string {
  if (day === 0) return "Today";
  const iso = dates?.[day];
  if (!iso) return `+${day}d`;
  const d = new Date(`${iso}T12:00:00`);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
}
