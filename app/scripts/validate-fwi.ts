/**
 * Validate our FWI System values against CWFIS's published ones.
 *
 *   npm run validate:fwi            (one Open-Meteo request; cached in scripts/.cache for the day)
 *
 * Reference points: every CWFIS fire weather station reporting today, plus up to MAX_HOTSPOTS of
 * today's CWFIS hotspots (CWFIS attaches its own FWI values to each). For each point we compute
 * today's FWI two ways and compare with CWFIS:
 *   A) independent  — FWI System spun up from standard startup values over 14 days of Open-Meteo
 *                     weather at that point, no CWFIS input at all (tests equations + weather);
 *   B) as the app   — moisture codes seeded from the nearest OTHER CWFIS point (≥ 25 km away,
 *                     within 400 km), like the app does, then today's ISI/BUI/FWI from our
 *                     12:00 Open-Meteo wind (tests what the map shows between stations).
 * Prints MAE / bias / danger-class agreement, and writes scripts/.cache/fwi-validation.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dangerClass, fwiDay, fwiFromCodes, STARTUP, type FwiCodes, type FwiDay } from "../src/data/cffdrs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".cache");
const WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows";
const PAST_DAYS = 14;
const MAX_HOTSPOTS = 120;
/** Leave-one-out: ignore reference points closer than this to the point being checked (km). */
const HOLDOUT_KM = 25;
const SEED_MAX_KM = 400;
/** Points blended in variant C. */
const SEED_K = 4;
/** Variant E: what counts as locally wet today. */
const WET_RAIN_MM = 1;
const WET_RH = 90;

interface Ref extends FwiDay { kind: "station" | "hotspot"; lat: number; lng: number }

async function wfs(typeName: string, props: string): Promise<Record<string, unknown>[]> {
  const q = new URLSearchParams({ service: "WFS", version: "1.0.0", request: "GetFeature", outputFormat: "application/json", typeName, propertyName: props });
  const r = await fetch(`${WFS}?${q}`);
  if (!r.ok) throw new Error(`${typeName} ${r.status}`);
  return ((await r.json()).features ?? []).map((f: { properties: Record<string, unknown> }) => f.properties);
}

const num = (v: unknown) => (v == null || v === "" ? NaN : Number(v));
const toRef = (p: Record<string, unknown>, kind: Ref["kind"]): Ref => ({
  kind, lat: num(p.lat), lng: num(p.lon),
  ffmc: num(p.ffmc), dmc: num(p.dmc), dc: num(p.dc), isi: num(p.isi), bui: num(p.bui), fwi: num(p.fwi),
});
const valid = (r: Ref) => [r.lat, r.lng, r.ffmc, r.dmc, r.dc, r.isi, r.bui, r.fwi].every(Number.isFinite);

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, d = Math.PI / 180;
  const x = (b.lng - a.lng) * d * Math.cos(((a.lat + b.lat) / 2) * d), y = (b.lat - a.lat) * d;
  return R * Math.hypot(x, y);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const stations = (await wfs("public:firewx_stns_current", "lat,lon,ffmc,dmc,dc,isi,bui,fwi")).map((p) => toRef(p, "station")).filter(valid);
  // Hotspots: thin to one per ~0.5° so a single big fire doesn't dominate the sample.
  const seen = new Set<string>();
  const hotspots = (await wfs("public:hotspots_last24hrs", "lat,lon,ffmc,dmc,dc,isi,bui,fwi")).map((p) => toRef(p, "hotspot")).filter(valid)
    .filter((h) => { const k = `${Math.round(h.lat * 2)},${Math.round(h.lng * 2)}`; return !seen.has(k) && !!seen.add(k); })
    .slice(0, MAX_HOTSPOTS);
  const refs = [...stations, ...hotspots];
  console.log(`Reference points: ${stations.length} CWFIS stations + ${hotspots.length} CWFIS hotspots (${today})`);

  // Weather at every point: one Open-Meteo request (cached for the day).
  mkdirSync(CACHE, { recursive: true });
  const cacheFile = join(CACHE, `fwi-validation-weather-${today}.json`);
  let rows: { hourly: Record<string, (number | null)[]>; daily: Record<string, (number | null)[]> & { time: string[] } }[];
  if (existsSync(cacheFile)) rows = JSON.parse(readFileSync(cacheFile, "utf8"));
  else {
    const q = new URLSearchParams({
      latitude: refs.map((r) => r.lat.toFixed(3)).join(","), longitude: refs.map((r) => r.lng.toFixed(3)).join(","),
      hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m", daily: "precipitation_sum",
      past_days: String(PAST_DAYS), forecast_days: "1", timezone: "auto",
    });
    const r = await fetch("https://api.open-meteo.com/v1/forecast", { method: "POST", body: q });
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}: ${await r.text()}`);
    const j = await r.json();
    rows = Array.isArray(j) ? j : [j];
    writeFileSync(cacheFile, JSON.stringify(rows));
  }

  const noon = (row: (typeof rows)[number], i: number) => ({
    t: num(row.hourly.temperature_2m[i * 24 + 12]), rh: num(row.hourly.relative_humidity_2m[i * 24 + 12]), ws: num(row.hourly.wind_speed_10m[i * 24 + 12]),
  });
  const month = (row: (typeof rows)[number], i: number) => Number(row.daily.time[i].slice(5, 7));

  const results = refs.map((ref, k) => {
    const row = rows[k];
    // A) independent spin-up through the past days into today.
    let c: FwiCodes = STARTUP, a: FwiDay = { ...STARTUP, isi: 0, bui: 0, fwi: 0 };
    for (let i = 0; i <= PAST_DAYS; i++) {
      const n = noon(row, i);
      a = fwiDay(c, n.t, n.rh, n.ws, num(row.daily.precipitation_sum[i]) || 0, month(row, i));
      c = a;
    }
    // B) as the app: nearest OTHER reference point's codes (leave-one-out), our 12:00 wind today.
    let seed: Ref | null = null, best = SEED_MAX_KM;
    for (const o of refs) {
      const d = km(ref, o);
      if (d >= HOLDOUT_KM && d < best) { best = d; seed = o; }
    }
    const b = seed ? fwiFromCodes(seed, noon(row, PAST_DAYS).ws) : null;
    // C) inverse-distance blend of the SEED_K nearest other points (leave-one-out).
    const near = refs.map((o) => ({ o, d: km(ref, o) })).filter((x) => x.d >= HOLDOUT_KM && x.d < SEED_MAX_KM).sort((x, y) => x.d - y.d).slice(0, SEED_K);
    let cc: FwiDay | null = null;
    if (near.length) {
      const w = near.map((x) => 1 / (x.d * x.d)), W = w.reduce((s, v) => s + v, 0);
      const mix = (key: "ffmc" | "dmc" | "dc") => near.reduce((s, x, i) => s + x.o[key] * w[i], 0) / W;
      cc = fwiFromCodes({ ffmc: mix("ffmc"), dmc: mix("dmc"), dc: mix("dc") }, noon(row, PAST_DAYS).ws);
    }
    // D) slow codes (DMC, DC) blended from official points; FFMC from our own local spin-up (A).
    const dd = near.length && cc ? fwiFromCodes({ ffmc: a.ffmc, dmc: cc.dmc, dc: cc.dc }, noon(row, PAST_DAYS).ws) : null;
    // E) blended codes (C), but where it's locally wet today (rain ≥ WET_RAIN_MM or noon RH ≥ WET_RH),
    //    step the seeded FFMC through today's local weather so local rain counts.
    const today = noon(row, PAST_DAYS), rainToday = num(row.daily.precipitation_sum[PAST_DAYS]) || 0;
    const wetHere = rainToday >= WET_RAIN_MM || today.rh >= WET_RH;
    const ee = cc ? (wetHere ? fwiFromCodes({ ffmc: fwiDay(cc, today.t, today.rh, today.ws, rainToday, month(row, PAST_DAYS)).ffmc, dmc: cc.dmc, dc: cc.dc }, today.ws) : cc) : null;
    // Share of the blend weight that came from hotspots (vs stations).
    const hsShare = near.length ? near.reduce((t, x) => t + (x.o.kind === "hotspot" ? 1 / (x.d * x.d) : 0), 0) / near.reduce((t, x) => t + 1 / (x.d * x.d), 0) : 0;
    // F) stations only (no hotspot seeds).
    const nearSt = refs.filter((o) => o.kind === "station").map((o) => ({ o, d: km(ref, o) })).filter((x) => x.d >= HOLDOUT_KM && x.d < SEED_MAX_KM).sort((x, y) => x.d - y.d).slice(0, SEED_K);
    let ff: FwiDay | null = null;
    if (nearSt.length) {
      const w = nearSt.map((x) => 1 / (x.d * x.d)), W = w.reduce((t, v) => t + v, 0);
      const mix = (key: "ffmc" | "dmc" | "dc") => nearSt.reduce((t, x, i) => t + x.o[key] * w[i], 0) / W;
      ff = fwiFromCodes({ ffmc: mix("ffmc"), dmc: mix("dmc"), dc: mix("dc") }, noon(row, PAST_DAYS).ws);
    }
    // G) a non-fire point (station) seeded from fire hotspots only: G1 all codes, G2 slow codes only + our FFMC.
    const nearHs = refs.filter((o) => o.kind === "hotspot").map((o) => ({ o, d: km(ref, o) })).filter((x) => x.d >= HOLDOUT_KM && x.d < SEED_MAX_KM).sort((x, y) => x.d - y.d).slice(0, SEED_K);
    let g1: FwiDay | null = null, g2: FwiDay | null = null, g3: FwiDay | null = null;
    if (nearHs.length && ref.kind === "station") {
      const w = nearHs.map((x) => 1 / (x.d * x.d)), W = w.reduce((t, v) => t + v, 0);
      const mix = (key: "ffmc" | "dmc" | "dc") => nearHs.reduce((t, x, i) => t + x.o[key] * w[i], 0) / W;
      g1 = fwiFromCodes({ ffmc: mix("ffmc"), dmc: mix("dmc"), dc: mix("dc") }, noon(row, PAST_DAYS).ws);
      g2 = fwiFromCodes({ ffmc: a.ffmc, dmc: mix("dmc"), dc: mix("dc") }, noon(row, PAST_DAYS).ws);
      g3 = fwiFromCodes({ ffmc: a.ffmc, dmc: (mix("dmc") + a.dmc) / 2, dc: (mix("dc") + a.dc) / 2 }, noon(row, PAST_DAYS).ws);
    }
    return { ref, a, b, c: cc, d: dd, e: ee, f: ff, g1, g2, g3, wet: wetHere, hsShare, seedKm: seed ? best : null };
  });

  const KEYS = ["ffmc", "dmc", "dc", "isi", "bui", "fwi"] as const;
  const report = (label: string, pairs: { ours: FwiDay; ref: Ref }[]) => {
    console.log(`\n${label}  (n = ${pairs.length})`);
    console.log("         MAE     bias    ref mean");
    const out: Record<string, { mae: number; bias: number; refMean: number }> = {};
    for (const key of KEYS) {
      const d = pairs.map((p) => p.ours[key] - p.ref[key]);
      const mae = d.reduce((s, v) => s + Math.abs(v), 0) / d.length, bias = d.reduce((s, v) => s + v, 0) / d.length;
      const refMean = pairs.reduce((s, p) => s + p.ref[key], 0) / pairs.length;
      out[key] = { mae, bias, refMean };
      console.log(`  ${key.toUpperCase().padEnd(5)} ${mae.toFixed(1).padStart(6)}  ${(bias >= 0 ? "+" : "") + bias.toFixed(1).padStart(6)}  ${refMean.toFixed(1).padStart(8)}`);
    }
    const same = pairs.filter((p) => dangerClass(p.ours.fwi) === dangerClass(p.ref.fwi)).length;
    const within1 = pairs.filter((p) => Math.abs(classIdx(p.ours.fwi) - classIdx(p.ref.fwi)) <= 1).length;
    console.log(`  Danger class: ${Math.round((100 * same) / pairs.length)} % exact, ${Math.round((100 * within1) / pairs.length)} % within one class`);
    return { n: pairs.length, ...out, classExact: same / pairs.length, classWithin1: within1 / pairs.length };
  };
  const classIdx = (f: number) => ["Low", "Moderate", "High", "Very High", "Extreme"].indexOf(dangerClass(f));

  const A = report("A) Independent: Open-Meteo weather only, standard spin-up", results.map((r) => ({ ours: r.a, ref: r.ref })));
  const withB = results.filter((r) => r.b);
  const B = report(`B) As the app: seeded from the nearest other CWFIS point (≥ ${HOLDOUT_KM} km, median ${median(withB.map((r) => r.seedKm!)).toFixed(0)} km away)`, withB.map((r) => ({ ours: r.b!, ref: r.ref })));
  const withC = results.filter((r) => r.c);
  const C = report(`C) As the app, blended: inverse-distance mix of the ${SEED_K} nearest other CWFIS points`, withC.map((r) => ({ ours: r.c!, ref: r.ref })));
  const withD = results.filter((r) => r.d);
  const D = report(`D) Slow codes (DMC, DC) blended from the ${SEED_K} nearest other CWFIS points; FFMC from local weather`, withD.map((r) => ({ ours: r.d!, ref: r.ref })));
  const withE = results.filter((r) => r.e);
  const E = report(`E) C, but FFMC stepped through today's local weather where it's wet (rain ≥ ${WET_RAIN_MM} mm or RH ≥ ${WET_RH} %)`, withE.map((r) => ({ ours: r.e!, ref: r.ref })));
  const wet = withE.filter((r) => r.wet);
  report(`   …only the locally wet points (n = ${wet.length}): C`, wet.map((r) => ({ ours: r.c!, ref: r.ref })));
  report(`   …only the locally wet points (n = ${wet.length}): E`, wet.map((r) => ({ ours: r.e!, ref: r.ref })));
  const hsDom = withC.filter((r) => r.hsShare > 0.5), stDom = withC.filter((r) => r.hsShare <= 0.5);
  report(`   C at points seeded mostly from HOTSPOTS (n = ${hsDom.length})`, hsDom.map((r) => ({ ours: r.c!, ref: r.ref })));
  report(`   C at points seeded mostly from STATIONS (n = ${stDom.length})`, stDom.map((r) => ({ ours: r.c!, ref: r.ref })));
  report("   …same hotspot-seeded points, unseeded (A)", hsDom.map((r) => ({ ours: r.a, ref: r.ref })));
  const withG = results.filter((r) => r.g1);
  report(`G1) STATIONS seeded from fire hotspots only, all codes (n = ${withG.length})`, withG.map((r) => ({ ours: r.g1!, ref: r.ref })));
  report("G2) same, slow codes from hotspots + FFMC from local weather", withG.map((r) => ({ ours: r.g2!, ref: r.ref })));
  report("G3) slow codes = mean of hotspot seed and local spin-up; FFMC local", withG.map((r) => ({ ours: r.g3!, ref: r.ref })));
  report("    same stations, unseeded (A)", withG.map((r) => ({ ours: r.a, ref: r.ref })));
  // Worst cases: how far off can a single point be?
  const worst = (pick: (r: (typeof results)[number]) => FwiDay | null) => results.filter((r) => pick(r)).map((r) => Math.abs(pick(r)!.fwi - r.ref.fwi)).sort((x, y) => y - x);
  for (const [k, f] of [["C", (r: (typeof results)[number]) => r.c], ["D", (r: (typeof results)[number]) => r.d], ["E", (r: (typeof results)[number]) => r.e]] as const) {
    const w = worst(f);
    console.log(`  ${k}: FWI error 95th percentile ${w[Math.floor(w.length * 0.05)].toFixed(1)}, worst ${w[0].toFixed(1)}`);
  }
  // B by distance to the seed point: how far is a seed still better than no seed (A)?
  console.log("\nFWI error by distance to the nearest official point (B vs A at the same points):");
  for (const [lo, hi] of [[25, 75], [75, 150], [150, 250], [250, 400]]) {
    const g = withB.filter((r) => r.seedKm! >= lo && r.seedKm! < hi);
    if (!g.length) continue;
    const mae = (f: (r: (typeof g)[number]) => number) => g.reduce((s, r) => s + Math.abs(f(r)), 0) / g.length;
    console.log(`  ${lo}-${hi} km  n=${String(g.length).padStart(3)}  seeded MAE ${mae((r) => r.b!.fwi - r.ref.fwi).toFixed(1)}  vs unseeded ${mae((r) => r.a.fwi - r.ref.fwi).toFixed(1)}`);
  }
  writeFileSync(join(CACHE, "fwi-validation.json"), JSON.stringify({ date: today, stations: stations.length, hotspots: hotspots.length, A, B, C, D, E }, null, 2));
}

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

main().catch((e) => { console.error(e); process.exit(1); });
