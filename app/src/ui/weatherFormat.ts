/** Small display helpers for weather values. */
const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Degrees → 8-point compass name. */
export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Forecast day index → "Now" / "Thu 2" (local date) / "+3d" when dates aren't loaded. */
export function dayLabel(day: number, dates?: string[]): string {
  if (day === 0) return "Now";
  const iso = dates?.[day];
  return iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : `+${day}d`;
}
