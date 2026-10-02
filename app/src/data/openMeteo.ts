/**
 * Open-Meteo (open-meteo.com) — free weather API, CORS enabled, no key.
 * Samples a lat/lng grid over the region bbox: two weeks of history, today and a 7-day
 * daily forecast, plus live current conditions.
 *
 * Fire danger is the Canadian FWI System (data/cffdrs.ts) run day by day through that
 * whole series per cell, with today's moisture codes taken from the nearest CWFIS fire
 * weather station when there is one (the official observed values). Fosberg is computed
 * too, for comparison with the team's sensor station.
 */
import { dangerClass, fwiDay, fwiFromCodes, riskFromFwi, STARTUP, type FwiCodes, type FwiDay } from "./cffdrs";
import { daysSinceRain, fosbergFFWI, FULLY_DRY_DAYS } from "./fosberg";

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
  wind: number; // km/h, the day's peak (display)
  /** 12:00 local wind (km/h): the FWI / FBP standard input (ISI, fire shape). */
  windNoon: number;
  windFrom: number; // degrees, direction the wind blows FROM (0 = north)
  rainMm: number; // that day's total
  daysSinceRain: number;
  ffwi: number; // Fosberg 0..100 (comparison with the sensor station)
  /** Canadian FWI System for the day: FFMC, DMC, DC, ISI, BUI, FWI. */
  ffmc: number;
  dmc: number;
  dc: number;
  isi: number;
  bui: number;
  fwi: number;
  /** Danger class from FWI: Low / Moderate / High / Very High / Extreme. */
  danger: string;
  risk: number; // 0..1, from FWI (data/cffdrs.ts riskFromFwi)
}

export interface WeatherCell {
  lat: number;
  lng: number;
  /** Index 0 = today, 1..FORECAST_DAYS = upcoming days. */
  days: DayWeather[];
  /** The PAST_DAYS days before today, oldest first (scored the same way; used to calibrate fire growth). */
  past: DayWeather[];
  /** Live conditions right now (display only; risk uses the daily peaks). */
  now: { temp: number; rh: number; wind: number; windFrom: number; /** mm in the last hour */ rain: number };
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
  /** Local ISO dates of `past`, oldest first. */
  pastDates: string[];
  fetchedAt: string;
}

type Num = number | null;

interface Row {
  /** Hourly series (local time): the FWI System's standard inputs are the 12:00 readings. */
  hourly: { temperature_2m: Num[]; relative_humidity_2m: Num[]; wind_speed_10m: Num[] };
  current: { temperature_2m: Num; relative_humidity_2m: Num; wind_speed_10m: Num; wind_direction_10m: Num; precipitation: Num };
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

function scoreDay(tempIn: Num | undefined, rhIn: Num | undefined, windIn: Num | undefined, windFromIn: Num | undefined, rainMm: number, dry: number, f: FwiDay, windNoon: number): DayWeather {
  const temp = num(tempIn), rh = num(rhIn), wind = num(windIn), windFrom = num(windFromIn);
  return { temp, rh, wind, windNoon: Number.isFinite(windNoon) ? windNoon : wind, windFrom, rainMm, daysSinceRain: dry, ffwi: fosbergFFWI(temp, rh, wind), ...f, danger: dangerClass(f.fwi), risk: riskFromFwi(f.fwi) };
}

/** Today's observed FWI codes near a point (nearest CWFIS station), or null. */
export type FwiSeed = (lat: number, lng: number) => FwiCodes | null;

export async function fetchWeatherGrid(bbox: [number, number, number, number], signal?: AbortSignal, seed?: FwiSeed): Promise<WeatherGrid> {
  // Open-Meteo counts every point as a call: size the grid so any province is ≤ ~90 points
  // (1.5° for Alberta-sized regions, coarser for Quebec / Nunavut).
  const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const step = Math.max(1.5, Math.ceil(Math.sqrt(area / 90) * 2) / 2);
  const lng0 = Math.floor(bbox[0]), lat0 = Math.floor(bbox[1]);
  const nLng = Math.ceil((bbox[2] - lng0) / step) + 1, nLat = Math.ceil((bbox[3] - lat0) / step) + 1;
  const lats: number[] = [], lngs: number[] = [];
  for (let j = 0; j < nLat; j++) for (let i = 0; i < nLng; i++) {
    lats.push(lat0 + j * step);
    lngs.push(lng0 + i * step);
  }
  const p = new URLSearchParams({
    latitude: lats.join(","), longitude: lngs.join(","),
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation",
    daily: "temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,precipitation_sum",
    hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m",
    past_days: String(PAST_DAYS), forecast_days: String(FORECAST_DAYS + 1), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const rows: Row[] = Array.isArray(json) ? json : [json];
  const cells = rows.map((r, k): WeatherCell => {
    const c = r.current, d = r.daily, rain = d.precipitation_sum;
    // FWI System through the whole series (past → today → forecast). Codes carry over day to day.
    // Standard inputs: 12:00 local temperature, RH and wind (hourly series), and the day's rain.
    const h = r.hourly;
    const noon = (i: number) => ({ t: num(h?.temperature_2m[i * 24 + 12]), rh: num(h?.relative_humidity_2m[i * 24 + 12]), ws: num(h?.wind_speed_10m[i * 24 + 12]) });
    const obs = seed?.(lats[k], lngs[k]) ?? null;
    let codes: FwiCodes = obs ? { ...STARTUP, dmc: obs.dmc, dc: obs.dc } : STARTUP; // slow codes seeded from the station
    const scored: DayWeather[] = [];
    for (let i = 0; i < PAST_DAYS + FORECAST_DAYS + 1; i++) {
      const month = Number((d.time[i] ?? "2000-07").slice(5, 7)) || 7;
      const n = noon(i);
      let f = fwiDay(codes, n.t, n.rh, n.ws, rain[i] ?? 0, month);
      // Today: the station's observed codes replace our spin-up (then the forecast runs on from them).
      if (i === PAST_DAYS && obs) f = fwiFromCodes(obs, n.ws);
      codes = f;
      scored.push(scoreDay(d.temperature_2m_max[i], d.relative_humidity_2m_min[i], d.wind_speed_10m_max[i], d.wind_direction_10m_dominant[i], rain[i] ?? 0, daysSinceRain(rain, i), f, n.ws));
    }
    // Day 0 = today: its rain total includes the forecast for the rest of today.
    const days = scored.slice(PAST_DAYS);
    const past = scored.slice(0, PAST_DAYS);
    const now = { temp: num(c.temperature_2m), rh: num(c.relative_humidity_2m), wind: num(c.wind_speed_10m), windFrom: num(c.wind_direction_10m), rain: num(c.precipitation) };
    return { lat: lats[k], lng: lngs[k], days, past, now };
  });
  const time = rows[0]?.daily.time ?? [];
  const dates = time.slice(PAST_DAYS, PAST_DAYS + FORECAST_DAYS + 1);
  return { lat0, lng0, step, nLat, nLng, cells, dates, pastDates: time.slice(0, PAST_DAYS), fetchedAt: new Date().toISOString() };
}

export function weatherAt(grids: WeatherGrid[], lat: number, lng: number): WeatherCell | null {
  for (const grid of grids) {
    const i = Math.round((lng - grid.lng0) / grid.step), j = Math.round((lat - grid.lat0) / grid.step);
    if (i < 0 || j < 0 || i >= grid.nLng || j >= grid.nLat) continue;
    return grid.cells[j * grid.nLng + i] ?? null;
  }
  return null;
}
