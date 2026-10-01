/** Small display helpers for weather values. */
const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Degrees → 8-point compass name. */
export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Forecast day index → "Today" / "Thu 1" (local date) / "+3d" when dates aren't loaded. */
export function dayLabel(day: number, dates?: string[]): string {
  if (day === 0) return "Today";
  const iso = dates?.[day];
  if (!iso) return `+${day}d`;
  const d = new Date(`${iso}T12:00:00`);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
}
