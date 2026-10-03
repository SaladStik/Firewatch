/**
 * Bakes a street-level raster for a city (src/config/cities.ts), in the same format as a region's
 * terrain.png so the map's worker can stack it in front of the province raster at street zoom:
 *
 *   Land cover : ESA WorldCover 2021 v200 at its native 10 m (CC-BY 4.0), 4-sample vote per pixel
 *   Elevation  : AWS Terrain Tiles (Terrarium) at zoom 13 (~12 m at 51° N)
 *
 * Output: public/data/<region>/cities/<city>.png + .json, and cities/index.json (the list).
 * Run: npm run bake:city -- calgary      (or no argument for every city; sources cached in scripts/.cache)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromUrl } from "geotiff";
import { PNG } from "pngjs";
import { CITIES, type CityRaster } from "../src/config/cities.ts";
import { PROJECTION } from "../src/config/regions.ts";
import { LandClass } from "../src/geo/landClass.ts";
import { project, setProjection, unproject } from "../src/geo/projection.ts";

const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, "scripts/.cache");
mkdirSync(CACHE, { recursive: true });
setProjection(PROJECTION);

/** ESA WorldCover code → our land class (same table as bake-terrain.ts). */
const WC: Record<number, LandClass> = {
  10: LandClass.Forest, 20: LandClass.Shrub, 30: LandClass.Grass, 40: LandClass.Crop,
  50: LandClass.Urban, 60: LandClass.Rock, 70: LandClass.Snow, 80: LandClass.Water,
  90: LandClass.Wetland, 95: LandClass.Wetland, 100: LandClass.Tundra,
};
/** WorldCover's native grid: 3° tiles of 36,000 px. */
const WC_PX_DEG = 12000;

async function cached(url: string, file: string): Promise<Buffer> {
  const p = join(CACHE, file);
  if (existsSync(p)) return readFileSync(p);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(p, buf);
  return buf;
}

async function bakeCity(c: CityRaster) {
  const [W0, S0, E0, N0] = c.bbox;

  // ---- raster grid: the projected rectangle around the bbox
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let t = 0; t <= 1; t += 0.05) for (const [lat, lng] of [[S0, W0 + (E0 - W0) * t], [N0, W0 + (E0 - W0) * t], [S0 + (N0 - S0) * t, W0], [S0 + (N0 - S0) * t, E0]]) {
    const p = project(lat, lng);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const PX = c.pxKm;
  const W = Math.ceil((maxX - minX) / PX), H = Math.ceil((maxZ - minZ) / PX);
  console.log(`${c.name}: ${W}×${H} px at ${PX * 1000} m`);

  // ---- land cover: one window at native 10 m (WorldCover tiles are 3°, named by their SW corner)
  const wcW = Math.round((E0 - W0) * WC_PX_DEG), wcH = Math.round((N0 - S0) * WC_PX_DEG);
  const wcFile = join(CACHE, `wc10_${c.id}_${wcW}x${wcH}.bin`);
  let wc: Uint8Array;
  if (existsSync(wcFile)) wc = new Uint8Array(readFileSync(wcFile));
  else {
    wc = new Uint8Array(wcW * wcH);
    const tiles: [number, number][] = [];
    for (let lat = Math.floor(S0 / 3) * 3; lat < N0; lat += 3) for (let lng = Math.floor(W0 / 3) * 3; lng < E0; lng += 3) tiles.push([lat, lng]);
    for (const [lat, lng] of tiles) {
      const name = `N${String(lat).padStart(2, "0")}${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}`;
      const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
      // The part of the city window inside this tile.
      const w = Math.max(W0, lng), e = Math.min(E0, lng + 3), s = Math.max(S0, lat), n = Math.min(N0, lat + 3);
      if (w >= e || s >= n) continue;
      const tw = Math.round((e - w) * WC_PX_DEG), th = Math.round((n - s) * WC_PX_DEG);
      process.stdout.write(`worldcover ${name} ${tw}×${th} … `);
      const tiff = await fromUrl(url);
      const r = (await tiff.readRasters({ bbox: [w, s, e, n], width: tw, height: th, resampleMethod: "nearest", interleave: true })) as unknown as ArrayLike<number>;
      const ox = Math.round((w - W0) * WC_PX_DEG), oy = Math.round((N0 - n) * WC_PX_DEG);
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) wc[(oy + j) * wcW + ox + i] = r[j * tw + i];
      console.log("ok");
    }
    writeFileSync(wcFile, wc);
  }
  const wcAt = (lat: number, lng: number) => {
    const i = Math.floor((lng - W0) * WC_PX_DEG), j = Math.floor((N0 - lat) * WC_PX_DEG);
    return i < 0 || j < 0 || i >= wcW || j >= wcH ? 0 : wc[j * wcW + i];
  };

  // ---- elevation: Terrarium tiles at demZoom, bilinear
  const Z = c.demZoom;
  const lng2tx = (lng: number) => ((lng + 180) / 360) * 2 ** Z;
  const lat2ty = (lat: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z; };
  const dem = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let tx = Math.floor(lng2tx(W0)); tx <= Math.floor(lng2tx(E0)); tx++) for (let ty = Math.floor(lat2ty(N0)); ty <= Math.floor(lat2ty(S0)); ty++) {
    jobs.push((async () => {
      const png = PNG.sync.read(await cached(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`, `dem_${Z}_${tx}_${ty}.png`));
      const e = new Float32Array(256 * 256);
      for (let i = 0; i < e.length; i++) e[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
      dem.set(`${tx}/${ty}`, e);
    })());
  }
  await Promise.all(jobs);
  console.log(`dem tiles: ${dem.size} at zoom ${Z}`);
  const demAt = (lat: number, lng: number) => {
    const fx = lng2tx(lng) * 256 - 0.5, fy = lat2ty(lat) * 256 - 0.5, px = Math.floor(fx), py = Math.floor(fy), tx = fx - px, ty = fy - py;
    const s = (x: number, y: number) => { const t = dem.get(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`); return t ? t[(y & 255) * 256 + (x & 255)] : 0; };
    return (s(px, py) * (1 - tx) + s(px + 1, py) * tx) * (1 - ty) + (s(px, py + 1) * (1 - tx) + s(px + 1, py + 1) * tx) * ty;
  };

  // ---- write: R,G = elevation (m), B = land class (0 = outside the city: the province raster shows through)
  const png = new PNG({ width: W, height: H });
  const d = PX / 4; // 4 land samples per pixel, at ±quarter-pixel offsets
  let eMin = Infinity, eMax = -Infinity;
  const counts = new Map<number, number>();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = minX + (i + 0.5) * PX, z = minZ + (j + 0.5) * PX;
    const { lat, lng } = unproject(x, z);
    const inside = lat >= S0 && lat <= N0 && lng >= W0 && lng <= E0;
    let cls = LandClass.None;
    if (inside) {
      const votes = new Map<number, number>();
      for (const [dx, dz] of [[-d, -d], [d, -d], [-d, d], [d, d]]) {
        const q = unproject(x + dx, z + dz), k = WC[wcAt(q.lat, q.lng)];
        if (k) votes.set(k, (votes.get(k) ?? 0) + 1);
      }
      let best = 0, bestN = 0;
      votes.forEach((n, k) => { if (n > bestN || (n === bestN && k === LandClass.Water)) { best = k; bestN = n; } });
      cls = (best || LandClass.Grass) as LandClass;
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
    const e = Math.max(0, Math.round(demAt(lat, lng)));
    if (inside) { eMin = Math.min(eMin, e); eMax = Math.max(eMax, e); }
    const k = (j * W + i) * 4;
    png.data[k] = e >> 8; png.data[k + 1] = e & 255; png.data[k + 2] = cls; png.data[k + 3] = 255;
  }
  const out = join(ROOT, "public/data", c.region, "cities");
  mkdirSync(out, { recursive: true });
  const buf = PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
  writeFileSync(join(out, `${c.id}.png`), buf);
  writeFileSync(join(out, `${c.id}.json`), JSON.stringify({ width: W, height: H, pxKm: PX, minX, minZ, elevMin: eMin, elevMax: eMax, border: [] }));
  console.log(`${c.id}.png ${(buf.length / 1e6).toFixed(1)} MB · elevation ${eMin}–${eMax} m · land ${[...counts].map(([k, n]) => `${Object.keys(LandClass).find((name) => LandClass[name as keyof typeof LandClass] === k)} ${Math.round((n / (W * H)) * 100)}%`).join(", ")}`);
}

const pick = process.argv[2];
const list = pick ? CITIES.filter((c) => c.id === pick) : CITIES;
if (!list.length) throw new Error(`Unknown city "${pick}". Known: ${CITIES.map((c) => c.id).join(", ")}`);
for (const c of list) await bakeCity(c);
// Index per region of every baked city (the worker reads it).
for (const region of new Set(CITIES.map((c) => c.region))) {
  const dir = join(ROOT, "public/data", region, "cities");
  const baked = CITIES.filter((c) => c.region === region && existsSync(join(dir, `${c.id}.png`))).map((c) => c.id);
  if (baked.length) writeFileSync(join(dir, "index.json"), JSON.stringify(baked));
}
