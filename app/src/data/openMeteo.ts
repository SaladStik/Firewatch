/**
 * Open-Meteo (open-meteo.com) — free weather API, CORS enabled, no key.
 * Samples a 1.5° lat/lng grid over the region bbox: today + a 7-day daily
 * forecast, live current conditions (display only) and two weeks of rain history
 * (for days-since-rain). Each day's peak is scored with the Fosberg FFWI × a
 * dryness factor (data/fosberg.ts).
 */
import { daysSinceRain, fireWeatherRisk, fosbergFFWI, FULLY_DRY_DAYS } from "./fosberg";

/** Days after today on the forecast slider (day 0 = today). */
export const FORECAST_DAYS = 7;
/** Rain history for days-since-rain; dryness saturates at FULLY_DRY_DAYS, so more is wasted quota. */
export const PAST_DAYS = FULLY_DRY_DAYS;

/**
 * One cell on one day. Each day uses the daily peak (max temperature, min
 * humidity, max wind, dominant direction), so today compares like with like.
 */
export interface DayWeather {
  temp: number; // °C
  rh: number; // %
  wind: number; // km/h
  windFrom: number; // degrees, direction the wind blows FROM (0 = north)
  rainMm: number; // that day's total
  daysSinceRain: number;
  ffwi: number; // Fosberg 0..100
  risk: number; // 0..1
}

export interface WeatherCell {
  lat: number;
  lng: number;
  /** Index 0 = today, 1..FORECAST_DAYS = upcoming days. */
  days: DayWeather[];
  /** Live conditions right now (display only; risk uses the daily peaks). */
  now: { temp: number; rh: number; wind: number; windFrom: number };
}

export interface WeatherGrid {
  lat0: number;
  lng0: number;
  step: number;
  nLat: number;
  nLng: number;
  cells: WeatherCell[];
  /** Local ISO date per day index (0 = today). */
  dates: string[];
  fetchedAt: string;
}

type Num = number | null;

interface Row {
  current: { temperature_2m: Num; relative_humidity_2m: Num; wind_speed_10m: Num; wind_direction_10m: Num };
  daily: {
    time: string[];
    temperature_2m_max: Num[];
    relative_humidity_2m_min: Num[];
    wind_speed_10m_max: Num[];
    wind_direction_10m_dominant: Num[];
    precipitation_sum: Num[];
  };
}

/** Missing API value → NaN (scores as 0, renders as "–"). */
const num = (v: Num | undefined) => v ?? NaN;

function scoreDay(tempIn: Num | undefined, rhIn: Num | undefined, windIn: Num | undefined, windFromIn: Num | undefined, rainMm: number, dry: number): DayWeather {
  const temp = num(tempIn), rh = num(rhIn), wind = num(windIn), windFrom = num(windFromIn);
  const ffwi = fosbergFFWI(temp, rh, wind);
  return { temp, rh, wind, windFrom, rainMm, daysSinceRain: dry, ffwi, risk: fireWeatherRisk(ffwi, dry) };
}

export async function fetchWeatherGrid(bbox: [number, number, number, number], signal?: AbortSignal): Promise<WeatherGrid> {
  // 1.5° keeps each province to ~50–160 points (Open-Meteo counts every point as a call).
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
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m",
    daily: "temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,precipitation_sum",
    past_days: String(PAST_DAYS), forecast_days: String(FORECAST_DAYS + 1), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const rows: Row[] = Array.isArray(json) ? json : [json];
  const cells = rows.map((r, k): WeatherCell => {
    const c = r.current, d = r.daily, rain = d.precipitation_sum;
    const days: DayWeather[] = [];
    // Day 0 = today: its rain total includes the forecast for the rest of today.
    for (let n = 0; n <= FORECAST_DAYS; n++) {
      const i = PAST_DAYS + n;
      days.push(scoreDay(d.temperature_2m_max[i], d.relative_humidity_2m_min[i], d.wind_speed_10m_max[i], d.wind_direction_10m_dominant[i], rain[i] ?? 0, daysSinceRain(rain, i)));
    }
    const now = { temp: num(c.temperature_2m), rh: num(c.relative_humidity_2m), wind: num(c.wind_speed_10m), windFrom: num(c.wind_direction_10m) };
    return { lat: lats[k], lng: lngs[k], days, now };
  });
  const dates = (rows[0]?.daily.time ?? []).slice(PAST_DAYS, PAST_DAYS + FORECAST_DAYS + 1);
  return { lat0, lng0, step, nLat, nLng, cells, dates, fetchedAt: new Date().toISOString() };
}

export function weatherAt(grids: WeatherGrid[], lat: number, lng: number): WeatherCell | null {
  for (const grid of grids) {
    const i = Math.round((lng - grid.lng0) / grid.step), j = Math.round((lat - grid.lat0) / grid.step);
    if (i < 0 || j < 0 || i >= grid.nLng || j >= grid.nLat) continue;
    return grid.cells[j * grid.nLng + i] ?? null;
  }
  return null;
}
