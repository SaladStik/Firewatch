/**
 * Canadian Forest Fire Danger Rating System (CFFDRS): the national standard, the same
 * system CWFIS / NRCan and every Canadian fire agency run.
 *
 *  - FWI System (fire weather): Van Wagner 1987, "Development and structure of the Canadian
 *    Forest Fire Weather Index System", Forestry Technical Report 35. Equations as in the
 *    reference implementation (Van Wagner & Pickett 1985; cffdrs R package, Wang et al. 2017).
 *    Moisture codes FFMC / DMC / DC carry over day to day; ISI, BUI and FWI derive from them.
 *  - FBP System (fire behaviour): Forestry Canada Fire Danger Group 1992, ST-X-3, with the
 *    2009 update (Wotton, Alexander & Taylor, GLC-X-10). Rate of spread by fuel type from
 *    ISI and BUI; length-to-breadth from wind; back spread from back ISI.
 *
 * Inputs are daily: temperature (°C), relative humidity (%), 10 m wind (km/h), 24 h rain (mm).
 */

export interface FwiCodes {
  ffmc: number;
  dmc: number;
  dc: number;
}

/** Standard startup values (Van Wagner 1987) when there's nothing better. */
export const STARTUP: FwiCodes = { ffmc: 85, dmc: 6, dc: 15 };

// Day-length factors (northern hemisphere, latitude > 30° N), by month 1..12.
const DMC_DAY_LENGTH = [6.5, 7.5, 9, 12.8, 13.9, 13.9, 12.4, 10.9, 9.4, 8, 7, 6];
const DC_DAY_LENGTH = [-1.6, -1.6, -1.6, 0.9, 3.8, 5.8, 6.4, 5, 2.4, 0.4, -1.6, -1.6];

/** Fine Fuel Moisture Code: litter / fine fuels, responds within hours to a day. */
export function ffmc(prev: number, temp: number, rh: number, ws: number, rain: number): number {
  rh = Math.min(100, Math.max(0, rh));
  let wmo = (147.2 * (101 - prev)) / (59.5 + prev);
  if (rain > 0.5) {
    const ra = rain - 0.5;
    wmo += 42.5 * ra * Math.exp(-100 / (251 - wmo)) * (1 - Math.exp(-6.93 / ra)) + (wmo > 150 ? 0.0015 * (wmo - 150) ** 2 * Math.sqrt(ra) : 0);
    wmo = Math.min(wmo, 250);
  }
  const ed = 0.942 * rh ** 0.679 + 11 * Math.exp((rh - 100) / 10) + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
  let wm = wmo;
  if (wmo > ed) {
    const z = 0.424 * (1 - (rh / 100) ** 1.7) + 0.0694 * Math.sqrt(ws) * (1 - (rh / 100) ** 8);
    const x = z * 0.581 * Math.exp(0.0365 * temp);
    wm = ed + (wmo - ed) / 10 ** x;
  } else {
    const ew = 0.618 * rh ** 0.753 + 10 * Math.exp((rh - 100) / 10) + 0.18 * (21.1 - temp) * (1 - Math.exp(-0.115 * rh));
    if (wmo < ew) {
      const z = 0.424 * (1 - ((100 - rh) / 100) ** 1.7) + 0.0694 * Math.sqrt(ws) * (1 - ((100 - rh) / 100) ** 8);
      const x = z * 0.581 * Math.exp(0.0365 * temp);
      wm = ew - (ew - wmo) / 10 ** x;
    }
  }
  return Math.min(101, Math.max(0, (59.5 * (250 - wm)) / (147.2 + wm)));
}

/** Duff Moisture Code: loosely compacted organic layer, ~2 week time lag. `month` 1..12. */
export function dmc(prev: number, temp: number, rh: number, rain: number, month: number): number {
  rh = Math.min(100, Math.max(0, rh));
  const t = Math.max(temp, -1.1);
  const rk = 1.894 * (t + 1.1) * (100 - rh) * DMC_DAY_LENGTH[month - 1] * 1e-4;
  let pr = prev;
  if (rain > 1.5) {
    const rw = 0.92 * rain - 1.27;
    const wmi = 20 + 280 / Math.exp(0.023 * prev);
    const b = prev <= 33 ? 100 / (0.5 + 0.3 * prev) : prev <= 65 ? 14 - 1.3 * Math.log(prev) : 6.2 * Math.log(prev) - 17.2;
    const wmr = wmi + (1000 * rw) / (48.77 + b * rw);
    pr = 43.43 * (5.6348 - Math.log(wmr - 20));
  }
  return Math.max(0, Math.max(0, pr) + rk);
}

/** Drought Code: deep compact organic layer, ~7 week time lag. `month` 1..12. */
export function dc(prev: number, temp: number, rain: number, month: number): number {
  const t = Math.max(temp, -2.8);
  const pe = Math.max(0, (0.36 * (t + 2.8) + DC_DAY_LENGTH[month - 1]) / 2);
  let dr = prev;
  if (rain > 2.8) {
    const rw = 0.83 * rain - 1.27;
    const smi = 800 * Math.exp(-prev / 400);
    dr = Math.max(0, prev - 400 * Math.log(1 + (3.937 * rw) / smi));
  }
  return Math.max(0, dr + pe);
}

/** Fine-fuel moisture function f(F) shared by ISI and back ISI. */
const fineFuel = (ffmcV: number) => {
  const fm = (147.2 * (101 - ffmcV)) / (59.5 + ffmcV);
  return 91.9 * Math.exp(-0.1386 * fm) * (1 + fm ** 5.31 / 4.93e7);
};

/** Initial Spread Index: expected rate of spread (wind × fine fuel moisture). */
export const isi = (ffmcV: number, ws: number) => 0.208 * Math.exp(0.05039 * ws) * fineFuel(ffmcV);

/** Back-fire ISI (FBP): same fuel moisture, wind working against it. */
export const backIsi = (ffmcV: number, ws: number) => 0.208 * Math.exp(-0.05039 * ws) * fineFuel(ffmcV);

/** Buildup Index: total fuel available (DMC + DC). */
export function bui(dmcV: number, dcV: number): number {
  if (dmcV <= 0 && dcV <= 0) return 0;
  const v = dmcV <= 0.4 * dcV
    ? (0.8 * dcV * dmcV) / (dmcV + 0.4 * dcV)
    : dmcV - (1 - (0.8 * dcV) / (dmcV + 0.4 * dcV)) * (0.92 + (0.0114 * dmcV) ** 1.7);
  return Math.max(0, v);
}

/** Fire Weather Index: fire intensity rating (ISI × BUI). */
export function fwi(isiV: number, buiV: number): number {
  const fD = buiV <= 80 ? 0.626 * buiV ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * buiV));
  const b = 0.1 * isiV * fD;
  return b <= 1 ? b : Math.exp(2.72 * (0.434 * Math.log(b)) ** 0.647);
}

export interface FwiDay extends FwiCodes {
  isi: number;
  bui: number;
  fwi: number;
}

/** One day of the FWI System from yesterday's codes. */
export function fwiDay(prev: FwiCodes, temp: number, rh: number, ws: number, rain: number, month: number): FwiDay {
  const t = Number.isFinite(temp) ? temp : 15, h = Number.isFinite(rh) ? rh : 50;
  const w = Number.isFinite(ws) ? Math.max(0, ws) : 0, r = Number.isFinite(rain) ? Math.max(0, rain) : 0;
  const f = ffmc(prev.ffmc, t, h, w, r), d = dmc(prev.dmc, t, h, r, month), c = dc(prev.dc, t, r, month);
  const i = isi(f, w), b = bui(d, c);
  return { ffmc: f, dmc: d, dc: c, isi: i, bui: b, fwi: fwi(i, b) };
}

/** ISI / BUI / FWI for known moisture codes (e.g. a station's observed values) and today's wind. */
export function fwiFromCodes(c: FwiCodes, ws: number): FwiDay {
  const w = Number.isFinite(ws) ? Math.max(0, ws) : 0;
  const i = isi(c.ffmc, w), b = bui(c.dmc, c.dc);
  return { ffmc: c.ffmc, dmc: c.dmc, dc: c.dc, isi: i, bui: b, fwi: fwi(i, b) };
}

// ------------------------------------------------------------ danger classes
/**
 * Fire danger class from FWI (the common Canadian 5-class rating used by CWFIS maps and many
 * agencies; exact breakpoints vary a little by province): Low < 5, Moderate 5–10, High 10–20,
 * Very High 20–30, Extreme ≥ 30.
 */
export const DANGER_CLASSES = [
  { name: "Low", min: 0 },
  { name: "Moderate", min: 5 },
  { name: "High", min: 10 },
  { name: "Very High", min: 20 },
  { name: "Extreme", min: 30 },
] as const;

export function dangerClass(fwiV: number) {
  let c: (typeof DANGER_CLASSES)[number] = DANGER_CLASSES[0];
  for (const d of DANGER_CLASSES) if (fwiV >= d.min) c = d;
  return c.name;
}

/**
 * FWI → the map's 0..1 weather risk, piecewise so the class breakpoints land on the map's
 * status thresholds: FWI 10 (High) = 0.5 "Elevated", 20 (Very High) = 0.68 "High",
 * 30 (Extreme) = 0.85 "Extreme".
 */
export function riskFromFwi(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (f < 10) return (f / 10) * 0.5;
  if (f < 20) return 0.5 + ((f - 10) / 10) * 0.18;
  if (f < 30) return 0.68 + ((f - 20) / 10) * 0.17;
  return Math.min(1, 0.85 + ((f - 30) / 30) * 0.15);
}

// ------------------------------------------------------------ FBP: rate of spread
/** FBP fuel types we map the land cover to (see FUEL_FOR_LAND in the engine / docs). */
export type FuelType = "C-2" | "D-1" | "M-1" | "O-1a" | "O-1b";

/** Rate-of-spread coefficients a, b, c (ST-X-3 Table 6) and buildup q, BUI0 (Table 7). */
const FUEL: Record<"C-2" | "D-1" | "O-1a" | "O-1b", { a: number; b: number; c: number; q: number; bui0: number }> = {
  "C-2": { a: 110, b: 0.0282, c: 1.5, q: 0.7, bui0: 64 },
  "D-1": { a: 30, b: 0.0232, c: 1.6, q: 0.9, bui0: 32 },
  "O-1a": { a: 190, b: 0.031, c: 1.4, q: 1, bui0: 1 },
  "O-1b": { a: 250, b: 0.035, c: 1.7, q: 1, bui0: 1 },
};
/** M-1 boreal mixedwood: percent conifer (FBP default when unknown is often 50). */
export const M1_PERCENT_CONIFER = 50;

/** Grass curing factor (Wotton et al. 2009, GLC-X-10 eq. 35). `curing` in %. */
export function curingFactor(curing: number): number {
  return curing < 58.8 ? 0.005 * (Math.exp(0.061 * curing) - 1) : 0.176 + 0.02 * (curing - 58.8);
}

/** Seasonal grass curing (%) by month when no observation exists: dead in spring/fall, green in summer. */
export const SEASONAL_CURING = [100, 100, 95, 85, 60, 35, 40, 55, 75, 90, 100, 100];

const rsiOf = (f: keyof typeof FUEL, isiV: number) => FUEL[f].a * (1 - Math.exp(-FUEL[f].b * isiV)) ** FUEL[f].c;
const beOf = (f: keyof typeof FUEL, buiV: number) =>
  f.startsWith("O-1") || buiV <= 0 ? 1 : Math.exp(50 * Math.log(FUEL[f].q) * (1 / buiV - 1 / FUEL[f].bui0));

/** Rate of spread (m/min) for a fuel type at a given ISI / BUI (grass needs `curing` %). */
export function rateOfSpread(fuel: FuelType, isiV: number, buiV: number, curing = 60): number {
  if (fuel === "M-1") {
    const pc = M1_PERCENT_CONIFER / 100;
    return pc * rsiOf("C-2", isiV) * beOf("C-2", buiV) + (1 - pc) * rsiOf("D-1", isiV) * beOf("D-1", buiV);
  }
  const rsi = rsiOf(fuel, isiV) * (fuel.startsWith("O-1") ? curingFactor(curing) : 1);
  return rsi * beOf(fuel, buiV);
}

/** Fire length-to-breadth ratio from 10 m wind (km/h): FBP eq. 79 (grass: eq. 80). */
export function lengthToBreadthFbp(fuel: FuelType, ws: number): number {
  if (fuel.startsWith("O-1")) return ws < 1 ? 1 : 1.1 * ws ** 0.464;
  return 1 + 8.729 * (1 - Math.exp(-0.03 * ws)) ** 2.155;
}

export interface FbpSpread {
  /** Head and back rate of spread (m/min). */
  ros: number;
  bros: number;
  lb: number;
}

/** Head / back spread rates and shape for one day of FWI values. */
export function fbpSpread(fuel: FuelType, day: { ffmc: number; isi: number; bui: number; wind: number }, curing = 60): FbpSpread {
  const ws = Number.isFinite(day.wind) ? Math.max(0, day.wind) : 0;
  return {
    ros: rateOfSpread(fuel, day.isi, day.bui, curing),
    bros: rateOfSpread(fuel, backIsi(day.ffmc, ws), day.bui, curing),
    lb: lengthToBreadthFbp(fuel, ws),
  };
}
