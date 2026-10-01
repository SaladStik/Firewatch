/**
 * Open-Meteo (open-meteo.com) — free weather API, CORS enabled, no key.
 * Samples a 1° lat/lng grid over the region bbox and derives a simple
 * hot-dry-windy risk score. Not an official index — see `weatherRisk()`.
 */
export interface WeatherCell {
  lat: number;
  lng: number;
  temp: number; // °C
  rh: number; // %
  wind: number; // km/h
  rain3d: number; // mm, last 3 days
  risk: number; // 0..1
}

export interface WeatherGrid {
  lat0: number;
  lng0: number;
  step: number;
  nLat: number;
  nLng: number;
  cells: WeatherCell[];
  fetchedAt: string;
}

/** Hot + dry + windy, damped by recent rain. Tweak freely. */
export function weatherRisk(temp: number, rh: number, wind: number, rain3d: number): number {
  const heat = Math.min(1, Math.max(0, (temp - 5) / 25));
  const dry = Math.min(1, Math.max(0, (80 - rh) / 60));
  const windy = Math.min(1, wind / 40);
  const base = 0.4 * dry + 0.35 * heat + 0.25 * windy;
  return Math.min(1, base * Math.exp(-rain3d / 8));
}

export async function fetchWeatherGrid(bbox: [number, number, number, number], signal?: AbortSignal): Promise<WeatherGrid> {
  // 1.5° keeps each province to ~50–150 points (Open-Meteo counts every point as a call).
  const step = 1.5;
  const lng0 = Math.floor(bbox[0]), lat0 = Math.floor(bbox[1]);
  const nLng = Math.ceil((bbox[2] - lng0) / step) + 1, nLat = Math.ceil((bbox[3] - lat0) / step) + 1;
  const lats: number[] = [], lngs: number[] = [];
  for (let j = 0; j < nLat; j++) for (let i = 0; i < nLng; i++) {
    lats.push(lat0 + j * step);
    lngs.push(lng0 + i * step);
  }
  const p = new URLSearchParams({
    latitude: lats.join(","), longitude: lngs.join(","),
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m",
    daily: "precipitation_sum", past_days: "3", forecast_days: "1", timezone: "UTC",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : [json];
  const cells = rows.map((r: {
    latitude: number; longitude: number;
    current: { temperature_2m: number; relative_humidity_2m: number; wind_speed_10m: number };
    daily: { precipitation_sum: (number | null)[] };
  }, k: number) => {
    const rain3d = (r.daily?.precipitation_sum ?? []).slice(0, 3).reduce<number>((a, b) => a + (b ?? 0), 0);
    const temp = r.current.temperature_2m, rh = r.current.relative_humidity_2m, wind = r.current.wind_speed_10m;
    return { lat: lats[k], lng: lngs[k], temp, rh, wind, rain3d, risk: weatherRisk(temp, rh, wind, rain3d) };
  });
  return { lat0, lng0, step, nLat, nLng, cells, fetchedAt: new Date().toISOString() };
}

export function weatherAt(grids: WeatherGrid[], lat: number, lng: number): WeatherCell | null {
  for (const grid of grids) {
    const i = Math.round((lng - grid.lng0) / grid.step), j = Math.round((lat - grid.lat0) / grid.step);
    if (i < 0 || j < 0 || i >= grid.nLng || j >= grid.nLat) continue;
    return grid.cells[j * grid.nLng + i] ?? null;
  }
  return null;
}
