/**
 * Case 3 — "Which wildfires get the next crew?" (IEEE YP Industry Hackathon 2026).
 *
 * Rank fires for a limited number of crews, beat "largest first", then cut crews by 20% and say
 * which fires lost a crew. Shared by the Dispatch panel, Firefly's tools and `npm run case:crews`.
 *
 * One-line score (all inputs known when the crew is sent; the fire's FINAL size is never used to rank):
 *
 *   priority = (1 + log10(1 + ha))^a  ×  (1 + ROS / 10)^b  ×  (1 + people / 3)^c  ×  (crown ? d : 1)
 *
 *   ha      size at assessment (history) / mapped area now (live)
 *   ROS     head-fire rate of spread (m/min): the faster of what was observed and what the
 *           Canadian FBP System gives for this fuel type in this temperature, humidity and wind
 *   people  log10 of people (and critical sites, as people-equivalents) within 30 km, distance-weighted
 *   crown   crown fires are much harder to catch
 *
 * The weights a–d start at hand-set values, then the agent tunes them on past seasons and keeps the
 * change only if it also catches more escapes on a season it didn't train on (the improvement round).
 */
import { fwiDay, rateOfSpread, STARTUP, type FuelType, type FwiCodes } from "../data/cffdrs";
import { bearingName, haversineKm, num, parseCsv } from "./csv";

// ------------------------------------------------------------ inputs
export interface CrewFire {
  /** Fire number (history) or live fire id. */
  id: string;
  name?: string;
  year?: number;
  lat: number;
  lng: number;
  /** Size known when the crew is sent (ha). */
  sizeHa: number;
  /** History only: final size (ha) — used to GRADE a ranking afterwards, never to make it. */
  finalHa?: number;
  sizeClass?: string;
  /** Spread rate observed at assessment (m/min), if recorded. */
  observedRos: number | null;
  tempC: number;
  rh: number;
  windKmh: number;
  month: number;
  fuel: FuelType;
  fuelCode: string;
  crown: boolean;
  start?: string;
  cause?: string;
  /** Live fires: today's FWI codes at the fire (otherwise estimated from the recorded weather). */
  fwi?: { isi: number; bui: number };
  /** Fields filled in because the record was blank. */
  imputed: string[];
}

export interface PlaceLite { name: string; lat: number; lng: number; pop: number }
export interface AssetLite { name: string; kind: string; lat: number; lng: number }

/** People-equivalents for a critical site in reach (hospital, school, plant, power). */
const ASSET_PEOPLE: Record<string, number> = { hospital: 5000, school: 1500, industrial: 3000, power: 2000 };
/** Communities and sites farther than this don't count toward exposure. */
export const EXPOSURE_KM = 30;

/** Alberta FBP fuel codes → the five fuel types our FBP implementation carries (data/cffdrs.ts). */
export function fuelFromCode(code: string): FuelType {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.startsWith("O1A")) return "O-1a";
  if (c.startsWith("O1B")) return "O-1b";
  if (c.startsWith("D")) return "D-1";
  if (c.startsWith("M")) return "M-1";
  return "C-2"; // C-1..C-7 conifer and S-1..S-3 slash: closest is boreal spruce
}

// ------------------------------------------------------------ the Alberta historical table
export interface HistoryLoad {
  fires: CrewFire[];
  rows: number;
  /** Rows dropped for missing size or coordinates (step 1 of the case). */
  dropped: number;
  /** Rows with weather / fuel / spread filled in, by field. */
  imputed: Record<string, number>;
  medians: { tempC: number; rh: number; windKmh: number };
}

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Parse Alberta's historical wildfire CSV (Open Alberta, `fp-historical-wildfire-data`). */
export function loadHistory(csv: string): HistoryLoad {
  const rows = parseCsv(csv);
  const kept = rows.filter((r) => num(r.CURRENT_SIZE) != null && num(r.LATITUDE) != null && num(r.LONGITUDE) != null && r.FIRE_NUMBER);
  const medians = {
    tempC: median(kept.map((r) => num(r.TEMPERATURE) ?? NaN)),
    rh: median(kept.map((r) => num(r.RELATIVE_HUMIDITY) ?? NaN)),
    windKmh: median(kept.map((r) => num(r.WIND_SPEED) ?? NaN)),
  };
  const imputed: Record<string, number> = {};
  const fill = (list: string[], field: string) => { list.push(field); imputed[field] = (imputed[field] ?? 0) + 1; };
  const fires = kept.map((r): CrewFire => {
    const im: string[] = [];
    const temp = num(r.TEMPERATURE), rh = num(r.RELATIVE_HUMIDITY), wind = num(r.WIND_SPEED);
    if (temp == null) fill(im, "temperature");
    if (rh == null) fill(im, "humidity");
    if (wind == null) fill(im, "wind");
    const fuelCode = r.FUEL_TYPE || "";
    if (!fuelCode) fill(im, "fuel");
    const start = r.FIRE_START_DATE || "";
    const month = Number(start.slice(5, 7)) || 6;
    const size = num(r.CURRENT_SIZE)!;
    const assess = num(r.ASSESSMENT_HECTARES);
    if (assess == null) fill(im, "assessment size");
    return {
      id: r.FIRE_NUMBER,
      name: r.FIRE_NAME || undefined,
      year: num(r.YEAR) ?? undefined,
      lat: num(r.LATITUDE)!,
      lng: num(r.LONGITUDE)!,
      sizeHa: Math.max(0.01, assess ?? 0.01),
      finalHa: size,
      sizeClass: r.SIZE_CLASS || undefined,
      observedRos: num(r.FIRE_SPREAD_RATE),
      tempC: temp ?? medians.tempC,
      rh: rh ?? medians.rh,
      windKmh: wind ?? medians.windKmh,
      month,
      fuel: fuelFromCode(fuelCode || "M2"), // unknown fuel: boreal mixedwood, Alberta's most common forest
      fuelCode: fuelCode || "M-2 (assumed)",
      crown: /crown/i.test(r.FIRE_TYPE || ""),
      start: start || undefined,
      cause: r.GENERAL_CAUSE || undefined,
      imputed: im,
    };
  });
  return { fires, rows: rows.length, dropped: rows.length - kept.length, imputed, medians };
}

// ------------------------------------------------------------ fire behaviour and exposure
/**
 * FBP head-fire rate of spread (m/min). Live fires use today's ISI/BUI at the fire; history
 * records only carry the day's weather, so the moisture codes are those that weather settles to
 * after two dry weeks (the FWI System run forward from its standard start-up values).
 */
export function fbpRos(f: CrewFire): number {
  let isiV: number, buiV: number;
  if (f.fwi) ({ isi: isiV, bui: buiV } = f.fwi);
  else {
    let c: FwiCodes = STARTUP;
    let d = fwiDay(c, f.tempC, f.rh, f.windKmh, 0, f.month);
    for (let i = 0; i < 14; i++) { c = d; d = fwiDay(c, f.tempC, f.rh, f.windKmh, 0, f.month); }
    isiV = d.isi; buiV = d.bui;
  }
  const curing = [100, 100, 95, 85, 60, 35, 40, 55, 75, 90, 100, 100][Math.min(11, Math.max(0, f.month - 1))];
  const ros = rateOfSpread(f.fuel, isiV, buiV, curing);
  return Number.isFinite(ros) ? ros : 0;
}

export interface Exposure {
  /** Distance-weighted people (+ site equivalents) within EXPOSURE_KM. */
  people: number;
  nearest: { name: string; km: number; pop: number; dir: string } | null;
  sites: { name: string; kind: string; km: number }[];
}

export function exposureOf(lat: number, lng: number, places: PlaceLite[], assets: AssetLite[]): Exposure {
  let people = 0;
  let nearest: Exposure["nearest"] = null;
  for (const p of places) {
    if (Math.abs(p.lat - lat) > 0.5 || Math.abs(p.lng - lng) > 0.8) continue; // cheap box before the trig
    const km = haversineKm(lat, lng, p.lat, p.lng);
    if (km < EXPOSURE_KM) people += p.pop * (1 - km / EXPOSURE_KM);
    if (p.pop >= 100 && (!nearest || km < nearest.km)) nearest = { name: p.name, km, pop: p.pop, dir: bearingName(p.lat, p.lng, lat, lng) };
  }
  const sites: Exposure["sites"] = [];
  for (const a of assets) {
    const km = haversineKm(lat, lng, a.lat, a.lng);
    if (km >= EXPOSURE_KM) continue;
    people += (ASSET_PEOPLE[a.kind] ?? 1000) * (1 - km / EXPOSURE_KM);
    sites.push({ name: a.name, kind: a.kind, km });
  }
  sites.sort((a, b) => a.km - b.km);
  return { people, nearest, sites };
}

// ------------------------------------------------------------ the score
export interface Weights { size: number; growth: number; people: number; crown: number }
/** Hand-set starting weights (round 1). */
export const HAND_WEIGHTS: Weights = { size: 1, growth: 1, people: 1, crown: 1.5 };

export interface Scored {
  fire: CrewFire;
  score: number;
  ros: number;
  fbp: number;
  exposure: Exposure;
  /** The reason a duty officer can say out loud. */
  reason: string;
}

const fmtHa = (ha: number) => (ha >= 100 ? Math.round(ha).toLocaleString("en-CA") : ha >= 1 ? ha.toFixed(1) : ha.toFixed(2));

export function scoreFire(fire: CrewFire, exposure: Exposure, w: Weights): Scored {
  const fbp = fbpRos(fire);
  const ros = Math.max(fbp, fire.observedRos ?? 0);
  const peopleLog = Math.log10(1 + exposure.people);
  const score = (1 + Math.log10(1 + fire.sizeHa)) ** w.size * (1 + ros / 10) ** w.growth * (1 + peopleLog / 3) ** w.people * (fire.crown ? w.crown : 1);
  return { fire, score, ros, fbp, exposure, reason: reasonFor(fire, ros, exposure) };
}

function reasonFor(f: CrewFire, ros: number, e: Exposure): string {
  const parts = [`${fmtHa(f.sizeHa)} ha`, `spreading ${ros >= 10 ? Math.round(ros) : ros.toFixed(1)} m/min (${f.fuelCode}${f.crown ? " crown" : ""}, wind ${Math.round(f.windKmh)} km/h, RH ${Math.round(f.rh)}%)`];
  if (e.nearest && e.nearest.km < EXPOSURE_KM) parts.push(`${Math.round(e.nearest.km)} km ${e.nearest.dir} of ${e.nearest.name} (${e.nearest.pop.toLocaleString("en-CA")})`);
  else if (e.nearest) parts.push(`remote, ${Math.round(e.nearest.km)} km from ${e.nearest.name}`);
  if (e.sites[0]) parts.push(`${e.sites[0].name} ${Math.round(e.sites[0].km)} km`);
  return parts.join(" · ");
}

// ------------------------------------------------------------ ranking, baseline, grading
export interface RankInput { fires: CrewFire[]; exposures: Map<string, Exposure>; }

const keyOf = (f: CrewFire) => `${f.year ?? ""}:${f.id}`;

export function exposures(fires: CrewFire[], places: PlaceLite[], assets: AssetLite[]): Map<string, Exposure> {
  return new Map(fires.map((f) => [keyOf(f), exposureOf(f.lat, f.lng, places, assets)]));
}

export function rankFires(inp: RankInput, w: Weights): Scored[] {
  return inp.fires.map((f) => scoreFire(f, inp.exposures.get(keyOf(f)) ?? { people: 0, nearest: null, sites: [] }, w)).sort((a, b) => b.score - a.score);
}

/** Baseline: biggest fire first (by the size known when the crew is sent). */
export function rankBaseline(inp: RankInput): Scored[] {
  return rankFires(inp, HAND_WEIGHTS).sort((a, b) => b.fire.sizeHa - a.fire.sizeHa);
}

/**
 * An escape: a fire still catchable when it was assessed (at most 200 ha) that went on to grow past
 * 200 ha (Alberta size class E). That's where a crew changes the outcome; a fire already past
 * 200 ha at assessment has escaped before anyone could be sent. Only known afterwards.
 */
export const ESCAPE_HA = 200;
export const isEscape = (f: CrewFire) => f.sizeHa <= ESCAPE_HA && (f.finalHa ?? 0) > ESCAPE_HA;
/** How much an escape near people matters: 1 for a remote fire, up to ~3 next to a city. */
export const escapeValue = (s: Scored) => (isEscape(s.fire) ? 1 + Math.log10(1 + s.exposure.people) / 3 : 0);

export interface Grade {
  /** Crewed fires that went on to escape (≤ 200 ha when assessed, > 200 ha final). */
  escapesCaught: number;
  /** The same, weighted by people in reach (escapeValue). */
  escapeValue: number;
  escapesTotal: number;
  /** Hectares those fires went on to burn after the crew arrived (final − assessed). */
  growthHa: number;
  /** People within 30 km of the crewed fires (distance-weighted). */
  people: number;
}

export function grade(picked: Scored[], all: CrewFire[]): Grade {
  return {
    escapesCaught: picked.filter((s) => isEscape(s.fire)).length,
    escapeValue: picked.reduce((t, s) => t + escapeValue(s), 0),
    escapesTotal: all.filter(isEscape).length,
    growthHa: picked.reduce((t, s) => t + Math.max(0, (s.fire.finalHa ?? s.fire.sizeHa) - s.fire.sizeHa), 0),
    people: picked.reduce((t, s) => t + s.exposure.people, 0),
  };
}

// ------------------------------------------------------------ the improvement round
/**
 * Weights the tuner may try. People never drop below 0.5: protecting communities is policy, not
 * something escape counts should be allowed to learn away (closeness to a town doesn't make a fire
 * more likely to escape, but it makes an escape cost more).
 */
const GRID = {
  size: [0.5, 1, 1.5, 2],
  growth: [0, 0.5, 1, 1.5, 2, 3],
  people: [0.5, 1, 2],
  crown: [1, 1.5, 2, 3],
};

/** Crews for a subset, in proportion to its share of the table (so seasons compare fairly). */
export const crewsFor = (n: number, subset: number, total: number) => Math.max(1, Math.round((n * subset) / total));

function fitness(inp: RankInput, w: Weights, n: number) {
  // Escapes reached, worth more near people; later growth breaks ties.
  const g = grade(rankFires(inp, w).slice(0, n), inp.fires);
  return g.escapeValue + g.growthHa / 1e8;
}

/** Search the weight grid for the ranking that reaches the most (people-weighted) escapes with `n` crews. */
export function fitWeights(inp: RankInput, n: number): Weights {
  let best = HAND_WEIGHTS, bestFit = fitness(inp, HAND_WEIGHTS, n);
  for (const size of GRID.size) for (const growth of GRID.growth) for (const people of GRID.people) for (const crown of GRID.crown) {
    const w = { size, growth, people, crown };
    const fit = fitness(inp, w, n);
    if (fit > bestFit + 1e-9) { best = w; bestFit = fit; }
  }
  return best;
}

export interface Tuning {
  weights: Weights;
  trainYears: number[];
  testYears: number[];
  /** Escapes caught on the held-out season(s): baseline, hand weights, tuned weights. */
  test: { baseline: number; hand: number; tuned: number; total: number; crews: number };
  train: { hand: number; tuned: number; total: number; crews: number };
  /** Tuned weights are kept only if they beat the hand weights on the held-out season. */
  kept: boolean;
}

/**
 * Round 2: search the weights on the training seasons, then check them on a season the search
 * never saw. The ranking only changes if the held-out result improves.
 */
export function tuneWeights(inp: RankInput, n: number, testYear: number): Tuning {
  const years = [...new Set(inp.fires.map((f) => f.year ?? 0))].sort();
  const trainYears = years.filter((y) => y !== testYear);
  const sub = (ys: number[]): RankInput => ({ fires: inp.fires.filter((f) => ys.includes(f.year ?? 0)), exposures: inp.exposures });
  const train = sub(trainYears), test = sub([testYear]);
  const nTrain = crewsFor(n, train.fires.length, inp.fires.length), nTest = crewsFor(n, test.fires.length, inp.fires.length);
  const best = fitWeights(train, nTrain);
  const caught = (list: Scored[], k: number) => list.slice(0, k).filter((s) => isEscape(s.fire)).length;
  const testHand = caught(rankFires(test, HAND_WEIGHTS), nTest), testTuned = caught(rankFires(test, best), nTest);
  return {
    weights: testTuned >= testHand ? best : HAND_WEIGHTS,
    trainYears,
    testYears: [testYear],
    test: { baseline: caught(rankBaseline(test), nTest), hand: testHand, tuned: testTuned, total: test.fires.filter(isEscape).length, crews: nTest },
    train: { hand: caught(rankFires(train, HAND_WEIGHTS), nTrain), tuned: caught(rankFires(train, best), nTrain), total: train.fires.filter(isEscape).length, crews: nTrain },
    kept: testTuned >= testHand,
  };
}

export interface Learned {
  /** The weights the ranking uses: fitted on every season, if the held-out checks passed. */
  weights: Weights;
  folds: Tuning[];
  /** Held-out escapes summed over the folds: baseline, hand weights, tuned weights. */
  heldOut: { baseline: number; hand: number; tuned: number; total: number };
  kept: boolean;
}

/**
 * The improvement round: leave one season out at a time (fit on two, test on the third). If tuned
 * weights beat the hand weights on the seasons they never saw, fit once more on all seasons and use
 * those; otherwise keep the hand weights.
 */
export function learnWeights(inp: RankInput, n: number): Learned {
  const years = [...new Set(inp.fires.map((f) => f.year ?? 0))].sort();
  const folds = years.length > 1 ? years.map((y) => tuneWeights(inp, n, y)) : [];
  const heldOut = folds.reduce((t, f) => ({ baseline: t.baseline + f.test.baseline, hand: t.hand + f.test.hand, tuned: t.tuned + f.test.tuned, total: t.total + f.test.total }), { baseline: 0, hand: 0, tuned: 0, total: 0 });
  const kept = folds.length > 0 && heldOut.tuned > heldOut.hand;
  return { weights: kept ? fitWeights(inp, n) : HAND_WEIGHTS, folds, heldOut, kept };
}

// ------------------------------------------------------------ the crew plan and the cut
export interface CrewPlan {
  crews: number;
  cutCrews: number;
  weights: Weights;
  ranked: Scored[];
  baseline: Scored[];
  /** Fires with a crew at full strength / after the cut. */
  picked: Scored[];
  pickedCut: Scored[];
  /** Fires that lost their crew in the cut (in our priority order). */
  lostCrew: Scored[];
  /** Fires the baseline would crew that we skip, and fires we crew that it skips. */
  skippedVsBaseline: Scored[];
  addedVsBaseline: Scored[];
  grades: { baseline: Grade; ours: Grade; cut: Grade; baselineCut: Grade } | null;
}

export function planCrews(inp: RankInput, crews: number, cutPct = 20, weights: Weights = HAND_WEIGHTS): CrewPlan {
  const n = Math.max(1, Math.min(crews, inp.fires.length));
  const cutCrews = Math.max(1, Math.round(n * (1 - cutPct / 100)));
  const ranked = rankFires(inp, weights), baseline = rankBaseline(inp);
  const picked = ranked.slice(0, n), pickedCut = ranked.slice(0, cutCrews), base = baseline.slice(0, n);
  const inCut = new Set(pickedCut.map((s) => keyOf(s.fire))), inBase = new Set(base.map((s) => keyOf(s.fire))), inOurs = new Set(picked.map((s) => keyOf(s.fire)));
  const graded = inp.fires.some((f) => f.finalHa != null);
  return {
    crews: n, cutCrews, weights, ranked, baseline,
    picked, pickedCut,
    lostCrew: picked.filter((s) => !inCut.has(keyOf(s.fire))),
    skippedVsBaseline: base.filter((s) => !inOurs.has(keyOf(s.fire))),
    addedVsBaseline: picked.filter((s) => !inBase.has(keyOf(s.fire))),
    grades: graded ? { baseline: grade(base, inp.fires), ours: grade(picked, inp.fires), cut: grade(pickedCut, inp.fires), baselineCut: grade(baseline.slice(0, cutCrews), inp.fires) } : null,
  };
}

/** The duty-officer paragraph: why these fires, what we skipped, who lost a crew. */
export function dutyBriefing(plan: CrewPlan, opts: { live?: boolean } = {}): string {
  const top = plan.pickedCut.slice(0, 3).map((s) => `${label(s)} (${s.reason.split(" · ").slice(0, 2).join(", ")})`).join("; ");
  const lost = plan.lostCrew.map(label);
  const skipped = plan.skippedVsBaseline.slice(0, 3).map((s) => `${label(s)} (${fmtHa(s.fire.sizeHa)} ha but ${s.ros < 2 ? "barely spreading" : `spreading only ${s.ros.toFixed(1)} m/min`}${s.exposure.people < 50 ? ", nobody within 30 km" : ""})`);
  const g = plan.grades;
  const vs = g ? ` Against "biggest first", the same ${plan.crews} crews reach ${g.ours.escapesCaught} fires that later escaped instead of ${g.baseline.escapesCaught}; with ${plan.cutCrews} crews it is ${g.cut.escapesCaught} vs ${g.baselineCut.escapesCaught}.` : "";
  return [
    `With ${plan.cutCrews} crews instead of ${plan.crews}, crews go first to the fires that combine size, fast spread for their fuel and weather, and people in reach: ${top}.`,
    lost.length ? `${lost.length} fire${lost.length === 1 ? "" : "s"} lost a crew in the cut, the lowest priorities on the list: ${lost.join(", ")}.` : "No fire lost a crew.",
    skipped.length ? `We deliberately skipped large but slow or remote fires that "biggest first" would send crews to: ${skipped.join("; ")}.` : "",
    vs,
    opts.live ? "Live fires: sizes from CWFIS perimeters and hotspots, spread from today's FWI and the fuel map." : "",
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export const label = (s: Scored) => `${s.fire.id}${s.fire.name ? ` ${s.fire.name.trim()}` : ""}`;
